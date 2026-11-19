"""Reproducible, idempotent import. Original Mongo collections are read-only."""
import argparse
from datetime import datetime,timezone
from pymongo import MongoClient
from . import config
from .model import reading
from .store import Store
from .mongo import Central

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before',required=True,help='Exclusive UTC cutover timestamp')
    args=parser.parse_args()
    cutoff=datetime.fromisoformat(args.before)
    if cutoff.tzinfo is None:
        parser.error('--before requires a time zone')
    import os
    store=Store(config.SQLITE_PATH)
    client=MongoClient(config.MONGO_URI,serverSelectionTimeoutMS=5000,tz_aware=True)
    collection=client[config.MONGO_DB][os.getenv('MONGO_COLLECTION','sensors_data')]
    count=bad=0
    seen=set()
    buffer=[]
    def flush():
        with store.connect() as connection:
            for value in buffer:
                store.ingest(value,preserve_context=True,latest=False,connection=connection)
        buffer.clear()
    try:
        for doc in collection.find({'timestamp':{'$lt':cutoff}}).sort('timestamp',1):
            try:
                minute_key=(doc['dispositivo_id'],doc['timestamp'].replace(second=0,microsecond=0))
                if minute_key in seen:
                    continue
                measures={k:{'value':v,'unit':'°C' if k=='temperatura' else 'pH' if k=='ph' else ''} for k,v in doc.get('datos',{}).items() if isinstance(v,(int,float)) and not isinstance(v,bool)}
                value=reading(config.GATEWAY,doc['dispositivo_id'],measures,
                              received_at=doc['timestamp'],context='unknown',source='legacy_storage_time')
                buffer.append(value)
                if len(buffer)>=64:
                    flush()
                seen.add(minute_key)
                count+=1
            except (ValueError,TypeError,KeyError):
                bad+=1
        flush()
        central=Central()
        central.indexes()
        while store.pending():
            central.sync_once(store)
        print(f'Procesados: {count}; rechazados: {bad}. Origen sin modificaciones.')
    finally:
        client.close()

if __name__=='__main__':
    main()
