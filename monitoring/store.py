"""SQLite durable spool. No pending record is removed by retention."""
import json
import sqlite3
import time
from contextlib import contextmanager, nullcontext
from datetime import datetime, timedelta
from pathlib import Path
from .model import iso, utcnow

class Store:
    def __init__(self, path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS records (
                  kind TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL,
                  version INTEGER NOT NULL DEFAULT 1, pending INTEGER NOT NULL DEFAULT 1,
                  PRIMARY KEY(kind,id));
                CREATE INDEX IF NOT EXISTS pending_records ON records(pending);
                CREATE INDEX IF NOT EXISTS record_hour ON records(kind,json_extract(document,'$.hour'),json_extract(document,'$.gateway_id'),json_extract(document,'$.device_id'),json_extract(document,'$.context'));
                CREATE INDEX IF NOT EXISTS record_time ON records(kind,json_extract(document,'$.gateway_id'),json_extract(document,'$.device_id'),json_extract(document,'$.timestamp'));
            ''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            db.execute('PRAGMA synchronous=FULL')
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def put(db, kind, document):
        document = dict(document, _replica_revision=f'{time.time_ns():020d}')
        db.execute('''INSERT INTO records(kind,id,document) VALUES(?,?,?)
          ON CONFLICT(kind,id) DO UPDATE SET document=excluded.document,
          version=records.version+1,pending=1''', (kind, document['_id'], json.dumps(document, allow_nan=False)))

    def documents(self, kind, query=None):
        sql='SELECT document FROM records WHERE kind=?'
        args=[kind]
        for key in ('gateway_id','device_id','context'):
            if query and key in query:
                sql+=f" AND json_extract(document,'$.{key}')=?"
                args.append(query[key])
        if query and 'timestamp' in query:
            sql+=" AND json_extract(document,'$.timestamp')>=? AND json_extract(document,'$.timestamp')<?"
            args.extend((query['timestamp']['$gte'],query['timestamp']['$lt']))
        with self.connect() as db:
            return [json.loads(r[0]) for r in db.execute(sql,args)]

    def device(self, gateway, device):
        key = gateway + ':' + device
        with self.connect() as db:
            row = db.execute("SELECT document FROM records WHERE kind='devices' AND id=?", (key,)).fetchone()
        return json.loads(row[0]) if row else {'_id': key, 'gateway_id': gateway, 'device_id': device,
                       'alias': device, 'location': '', 'context': 'dry_test'}

    def update_device(self, gateway, device, changes):
        with self.connect() as db:
            key = gateway + ':' + device
            row = db.execute("SELECT document FROM records WHERE kind='devices' AND id=?", (key,)).fetchone()
            doc = json.loads(row[0]) if row else self.device(gateway, device)
            doc.update(changes)
            doc['updated_at'] = iso(utcnow())
            self.put(db, 'devices', doc)
        return doc

    def ingest(self, reading, *, preserve_context=False, latest=True, connection=None):
        r = dict(reading)
        gateway, device = r['gateway_id'], r['device_id']
        moment = datetime.fromisoformat(r['received_at'])
        minute = iso(moment.replace(second=0, microsecond=0))
        hour = iso(moment.replace(minute=0, second=0, microsecond=0))
        with (nullcontext(connection) if connection is not None else self.connect()) as db:
            key = gateway + ':' + device
            row = db.execute("SELECT document FROM records WHERE kind='devices' AND id=?", (key,)).fetchone()
            metadata = json.loads(row[0]) if row else self.device(gateway, device)
            if not row:
                self.put(db, 'devices', metadata)
            if not preserve_context:
                r['context'] = metadata['context']
            if latest:
                self.put(db, 'latest', dict(r, _id=key, timestamp=r['received_at']))
            sample_id = f"{key}:{minute}:{r['context']}"
            if db.execute("SELECT 1 FROM records WHERE kind='minutes' AND id=?", (sample_id,)).fetchone():
                return
            sample = dict(r, _id=sample_id, timestamp=minute, hour=hour)
            self.put(db, 'minutes', sample)
            rows = db.execute("SELECT document FROM records WHERE kind='minutes' AND json_extract(document,'$.hour')=? AND json_extract(document,'$.gateway_id')=? AND json_extract(document,'$.device_id')=? AND json_extract(document,'$.context')=?", (hour,gateway,device,r['context']))
            samples = sorted((json.loads(x[0]) for x in rows), key=lambda x: x['received_at'])
            stats = {}
            for name in set().union(*(s['measurements'] for s in samples)):
                items = [s['measurements'][name] for s in samples if name in s['measurements'] and s['measurements'][name]['quality'] != 'invalid']
                if items:
                    vals = [x['value'] for x in items]
                    stats[name] = {'mean': sum(vals)/len(vals), 'min': min(vals), 'max': max(vals), 'count': len(vals), 'unit': items[0]['unit'], 'quality': 'valid' if all(x['quality']=='valid' for x in items) else 'unverified'}
            point = samples[0] if datetime.fromisoformat(samples[0]['received_at']).minute == 0 else None
            hourly = {'_id': f"{key}:{hour}:{r['context']}", 'schema_version':1,
                      'gateway_id':gateway, 'device_id':device, 'timestamp':hour,
                      'context':r['context'], 'summary':stats,
                      'point': {k:v for k,v in point['measurements'].items() if v['quality']!='invalid'} if point else None,
                      'point_received_at': point['received_at'] if point else None,
                      'sample_count':len(samples)}
            self.put(db, 'hours', hourly)

    def pending(self, limit=200):
        with self.connect() as db:
            return [(kind,key,json.loads(doc),version) for kind,key,doc,version in db.execute('SELECT kind,id,document,version FROM records WHERE pending=1 ORDER BY rowid LIMIT ?', (limit,))]

    def acknowledge(self, kind, key, version):
        with self.connect() as db:
            db.execute('UPDATE records SET pending=0 WHERE kind=? AND id=? AND version=?', (kind,key,version))

    def acknowledge_many(self, rows):
        with self.connect() as db:
            db.executemany('UPDATE records SET pending=0 WHERE kind=? AND id=? AND version=?', rows)

    def prune(self):
        cutoff = iso(utcnow()-timedelta(days=7))
        with self.connect() as db:
            db.execute("DELETE FROM records WHERE kind='minutes' AND pending=0 AND json_extract(document,'$.timestamp')<?", (cutoff,))

    def health(self):
        with self.connect() as db:
            pending = db.execute('SELECT count(*) FROM records WHERE pending=1').fetchone()[0]
        return {'pending_records':pending}
