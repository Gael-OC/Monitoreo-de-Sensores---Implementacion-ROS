#!/usr/bin/env python3
"""Configure private ESP WiFi files from the active PC hotspot, without printing secrets."""
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys
import uuid


def nm(*args):
    result=subprocess.run(['nmcli','--escape','no',*args],capture_output=True,text=True,check=True,timeout=15)
    return result.stdout.strip()


def main():
    if os.geteuid()!=0:
        raise SystemExit('Ejecuta este asistente con sudo en el PC del laboratorio.')
    if len(sys.argv)!=2:
        raise SystemExit('Uso: sudo python3 configure-lab-wifi.py /ruta/microros-esp')
    target=Path(sys.argv[1]).resolve()/'main/versions/wifi'
    if not (target/'generate_wifi_config.py').is_file():
        raise SystemExit('No se encontró el proyecto ESP-IDF indicado.')
    identity=pwd.getpwnam(os.environ.get('SUDO_USER','lab-ros'))
    profile=nm('-g','GENERAL.CON-UUID','device','show','wlx7820516a295a')
    uuid.UUID(profile)
    ssid=nm('-g','802-11-wireless.ssid','connection','show','uuid',profile)
    secret=nm('--show-secrets','-g','802-11-wireless-security.psk','connection','show','uuid',profile)
    if not ssid or not secret or secret=='<hidden>':
        raise SystemExit('NetworkManager no entregó credenciales; no se modificó ningún archivo.')
    values={'WIFI_SSID':ssid,'WIFI_PASSWORD':secret,'AGENT_IP':'10.42.0.1','AGENT_PORT':'8888'}
    header='#ifndef WIFI_CONFIG_H\n#define WIFI_CONFIG_H\n'
    for key,value in values.items():
        header+=f'#define {key} '+(value if key=='AGENT_PORT' else json.dumps(value,ensure_ascii=False))+'\n'
    header+='#endif\n'
    env=''.join(f'{key}={json.dumps(value,ensure_ascii=False)}\n' for key,value in values.items())
    for name,content in (('.env',env),('wifi_config.h',header)):
        temporary=target/(name+'.tmp')
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        with os.fdopen(fd,'w') as output:output.write(content)
        os.chown(temporary,identity.pw_uid,identity.pw_gid)
        os.replace(temporary,target/name)
    print('WiFi del hotspot activo configurado sin mostrar credenciales. Ya se puede compilar.')


if __name__=='__main__':
    main()
