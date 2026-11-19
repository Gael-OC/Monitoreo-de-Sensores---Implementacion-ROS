"""Central replica. Errors never acknowledge the local spool."""
import logging
import threading
from datetime import datetime, timezone
from pymongo import MongoClient, ReplaceOne
from pymongo.errors import DuplicateKeyError, BulkWriteError
import time
from . import config

class Central:
    def __init__(self):
        self.client = MongoClient(config.MONGO_URI, serverSelectionTimeoutMS=2000,
                                  connectTimeoutMS=2000, socketTimeoutMS=4000) if config.MONGO_URI else None
        self.db = self.client[config.MONGO_DB] if self.client is not None else None
        self.online = False

    def collection(self, kind):
        return self.db[config.PREFIX+kind]

    def indexes(self):
        if self.db is None:
            return
        for kind in ('minutes','hours'):
            self.collection(kind).create_index([('gateway_id',1),('device_id',1),('timestamp',1)])
            self.collection(kind).create_index('timestamp')
        # TTL requires BSON dates; the portable JSON timestamp remains available for queries.
        self.collection('minutes').create_index('expires_at', expireAfterSeconds=0)

    def prepare(self, kind, doc):
        document=dict(doc)
        if kind=='minutes':
            from datetime import timedelta
            document['expires_at']=datetime.fromisoformat(doc['timestamp'])+timedelta(days=7)
        revision=document.setdefault('_replica_revision',f'{time.time_ns():020d}')
        query={'_id':doc['_id'], '$or':[
            {'_replica_revision':{'$lte':revision}},
            {'_replica_revision':{'$exists':False}}]}
        return query,document

    def push(self, kind, doc):
        if self.db is None:
            raise ConnectionError('MongoDB no configurado')
        query,document=self.prepare(kind,doc)
        try:
            self.collection(kind).replace_one(query,document,upsert=True)
        except DuplicateKeyError:
            pass  # A newer replica won the race.

    def read(self, kind, query=None):
        if self.db is None:
            return []
        try:
            rows=list(self.collection(kind).find(query or {}, {'expires_at':0}).limit(50000).max_time_ms(3000))
            self.online=True
            return rows
        except Exception:
            self.online=False
            logging.warning('Almacenamiento central no disponible; se usa la copia local')
            return []

    def sync_once(self, store):
        if self.db is not None:
            # Configuration changed in the central panel is applied by its gateway.
            for remote in self.read('devices', {'gateway_id':config.GATEWAY}):
                local=store.device(remote['gateway_id'],remote['device_id'])
                if remote.get('updated_at','') > local.get('updated_at',''):
                    with store.connect() as connection:
                        store.put(connection,'devices',remote)
        batch=store.pending()
        if self.db is None:
            for kind,key,doc,version in batch:
                self.push(kind,doc)
                store.acknowledge(kind,key,version)
        else:
            # Batch network writes; local persistence remains one transaction per sample.
            for kind in {r[0] for r in batch}:
                rows=[r for r in batch if r[0]==kind]
                operations=[ReplaceOne(*self.prepare(kind,r[2]),upsert=True) for r in rows]
                try:
                    self.collection(kind).bulk_write(operations,ordered=False)
                except BulkWriteError as error:
                    details=error.details
                    if details.get('writeConcernErrors') or any(e['code']!=11000 for e in details.get('writeErrors',[])):
                        raise
                store.acknowledge_many([(kind,key,version) for _,key,_,version in rows])
        self.online=True
        store.prune()

    def worker(self, store, stop):
        indexed=False
        while not stop.is_set():
            try:
                if not indexed:
                    self.indexes()
                    indexed=True
                self.sync_once(store)
            except Exception:
                self.online=False
                logging.warning('Sin sincronización central; pendientes conservados en SQLite')
            stop.wait(10)
