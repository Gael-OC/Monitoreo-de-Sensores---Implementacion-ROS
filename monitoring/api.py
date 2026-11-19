import csv
import io
import time
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from . import config
from .model import iso, utcnow
from .store import Store
from .mongo import Central

store=Store(config.SQLITE_PATH)
central=Central()
remote_snapshot={}

@asynccontextmanager
async def lifespan(app):
    stop=threading.Event()
    def refresh_remote():
        global remote_snapshot
        while not stop.is_set():
            remote_snapshot={kind:central.read(kind) for kind in ('devices','latest')}
            stop.wait(10)
    worker=threading.Thread(target=refresh_remote,daemon=True)
    worker.start()
    yield
    stop.set()
    worker.join(timeout=9)

app=FastAPI(title='Monitoreo de microalgas',version='1.0.0',lifespan=lifespan)
STATIC=Path(__file__).parent/'static'
app.mount('/static',StaticFiles(directory=STATIC),name='static')

@app.middleware('http')
async def security(request: Request, call_next):
    if request.method not in {'GET','HEAD','OPTIONS'}:
        origin=request.headers.get('origin')
        expected=f'{request.url.scheme}://{request.headers.get("host", "")}'
        if origin and origin != expected:
            return Response('Origen no permitido',status_code=403)
    response=await call_next(request)
    response.headers['X-Content-Type-Options']='nosniff'
    response.headers['Content-Security-Policy']="default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    response.headers['Cache-Control']='no-store'
    return response

def combined(kind, query=None):
    if query and query.get('gateway_id')==config.GATEWAY:
        # This gateway's durable SQLite copy is authoritative, even offline.
        remote={}
    elif kind in ('devices','latest'):
        remote={x['_id']:x for x in remote_snapshot.get(kind,[])}
    else:
        remote={x['_id']:x for x in central.read(kind,query)}
    for doc in store.documents(kind,query):
        if query:
            if any(doc.get(k)!=v for k,v in query.items() if not isinstance(v,dict)):
                continue
            bounds=query.get('timestamp',{})
            if bounds and not bounds['$gte'] <= doc.get('timestamp','') < bounds['$lt']:
                continue
        # Local gateway is authoritative, remote gateways are read from central storage.
        remote[doc['_id']]=doc
    return list(remote.values())

@app.get('/')
def home():
    return FileResponse(STATIC/'index.html')

@app.get('/nodos')
def nodes_page():
    return FileResponse(STATIC/'nodos.html')

@app.get('/historial')
def history_page():
    return FileResponse(STATIC/'historial.html')

@app.get('/pared')
def wall():
    return FileResponse(STATIC/'pared.html')

@app.get('/healthz')
def health():
    return dict(store.health(),central_available=central.online,gateway_id=config.GATEWAY)

@app.get('/api/v1/devices')
def devices():
    metadata={d['_id']:d for d in combined('devices')}
    latest={d['_id']:d for d in combined('latest')}
    result=[]
    for key in sorted(metadata.keys()|latest.keys()):
        meta=metadata.get(key,{'_id':key,'alias':key,'location':''})
        if meta.get('gateway_id')==config.GATEWAY and not config.accepts_device(meta.get('device_id')):
            continue
        last=latest.get(key)
        age=max(0,(utcnow()-datetime.fromisoformat(last['received_at'])).total_seconds()) if last else None
        result.append(dict(meta,latest=last,age_seconds=age,recent=age is not None and age<=max(30,3*meta.get('expected_interval_seconds',4))))
    return {'devices':result,**health()}

class DeviceUpdate(BaseModel):
    alias: str | None=Field(default=None,min_length=1,max_length=80)
    location: str | None=Field(default=None,max_length=160)
    context: Literal['dry_test','culture','unknown'] | None=None
    expected_interval_seconds: int | None=Field(default=None,ge=1,le=86400)

@app.patch('/api/v1/devices/{gateway}/{device}')
def update_device(gateway: str,device: str,change: DeviceUpdate):
    key=gateway+':'+device
    known={d['_id']:d for d in combined('devices')}
    if key not in known:
        raise HTTPException(404,'Módulo desconocido')
    updates=change.model_dump(exclude_none=True)
    if gateway==config.GATEWAY:
        doc=store.update_device(gateway,device,updates)
        return doc
    doc=dict(known[key],**updates,updated_at=iso(utcnow()),_replica_revision=f'{time.time_ns():020d}')
    try:
        central.push('devices',doc)
    except Exception:
        raise HTTPException(503,'No se pudo actualizar el gateway remoto')
    return doc

def select_history(gateway,device,start,end,resolution,context):
    if gateway==config.GATEWAY and not config.accepts_device(device):
        raise HTTPException(404,'Módulo fuera de la captura activa')
    finish=end or utcnow()
    begin=start or finish-timedelta(days=1)
    try:
        lower,upper=iso(begin),iso(finish)
    except ValueError as e:
        raise HTTPException(422,str(e))
    if finish<=begin or finish-begin>timedelta(days=31):
        raise HTTPException(422,'Selecciona un rango positivo de hasta 31 días')
    query={'gateway_id':gateway,'device_id':device,'timestamp':{'$gte':lower,'$lt':upper}}
    if context:
        query['context']=context
    rows=combined('hours' if resolution=='hour' else 'minutes',query)
    rows.sort(key=lambda d:(d['timestamp'],d['context']))
    return rows

def present(row,resolution,mode):
    doc=dict(row)
    if resolution=='hour':
        doc['measurements']=({k:{'value':v['mean'],'unit':v['unit'],'quality':v['quality']} for k,v in row['summary'].items()} if mode=='summary' else (row['point'] or {}))
        doc['complete']=bool(row['summary']) and row['sample_count']==60 and all(v['count']==60 for v in row['summary'].values())
        doc['closed']=datetime.fromisoformat(row['timestamp'])+timedelta(hours=1)<=utcnow()
    else:
        doc['measurements']={k:v for k,v in row['measurements'].items() if v['quality']!='invalid'}
    return doc

@app.get('/api/v1/history')
def history(gateway: str,device: str,start: datetime|None=None,end: datetime|None=None,
            resolution: Literal['hour','minute']='hour',mode: Literal['summary','point']='summary',
            context: Literal['dry_test','culture','unknown']|None=None):
    rows=select_history(gateway,device,start,end,resolution,context)
    return {'records':[present(row,resolution,mode) for row in rows], 'resolution':resolution,'mode':mode,**health()}

@app.get('/api/v1/export.csv')
def export(gateway: str,device: str,start: datetime|None=None,end: datetime|None=None,
           resolution: Literal['hour','minute']='hour',mode: Literal['summary','point']='summary',
           context: Literal['dry_test','culture','unknown']|None=None):
    rows=select_history(gateway,device,start,end,resolution,context)
    stream=io.StringIO(newline='')
    writer=csv.writer(stream)
    writer.writerow(['fecha_utc','gateway','dispositivo','contexto','modo','sensor','valor','unidad','calidad','minimo','maximo','muestras','fecha_puntual_utc'])
    for row in rows:
        shown=present(row,resolution,mode)
        names=set(shown['measurements'])|set(row.get('summary',{}))
        for name in sorted(names):
            m=shown['measurements'].get(name,{})
            s=row.get('summary',{}).get(name,{})
            cells=[row['timestamp'],gateway,device,row['context'],mode if resolution=='hour' else 'minute',name,m.get('value',''),m.get('unit',s.get('unit','')),m.get('quality','unverified'),s.get('min',''),s.get('max',''),s.get('count',1 if m else 0),row.get('point_received_at','')]
            # Spreadsheet formula injection is possible even in identity/unit columns.
            writer.writerow(["'"+v if isinstance(v,str) and v.startswith(('=','+','-','@','\t','\r')) else v for v in cells])
    return Response('\ufeff'+stream.getvalue(),media_type='text/csv',headers={'Content-Disposition':'attachment; filename="mediciones.csv"'})
