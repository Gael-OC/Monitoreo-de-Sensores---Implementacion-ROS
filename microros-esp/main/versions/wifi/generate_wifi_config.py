#!/usr/bin/env python3
"""Prepare private WiFi settings before ESP-IDF loads sdkconfig."""
import ast
import json
import os
from pathlib import Path
import re
import sys

SCRIPT_DIR=Path(__file__).resolve().parent
ENV_FILE=SCRIPT_DIR/'.env'
OUTPUT_FILE=SCRIPT_DIR/'wifi_config.h'
PROJECT_DIR=SCRIPT_DIR.parents[2]


def parse_env_file(filepath):
    config={}
    for line in Path(filepath).read_text().splitlines():
        line=line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key,value=line.split('=',1)
        value=value.strip()
        if value.startswith(('"',"'")):
            value=ast.literal_eval(value)
        config[key.strip()]=value
    return config


def write_private(path,content):
    path=Path(path)
    if path.exists() and path.read_text()==content:
        return
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as output:output.write(content)
    path.chmod(0o600)


def generate_header(config):
    required=('WIFI_SSID','WIFI_PASSWORD','AGENT_IP','AGENT_PORT')
    if any(not isinstance(config.get(k),str) or not config[k].strip() for k in required):
        raise ValueError('Faltan variables WiFi/Agent en .env')
    port=int(config['AGENT_PORT'])
    if not 1<=port<=65535:raise ValueError('Puerto Agent inválido')
    if len(config['WIFI_SSID'].encode())>32:raise ValueError('SSID demasiado largo')
    header='#ifndef WIFI_CONFIG_H\n#define WIFI_CONFIG_H\n'
    for key in required:
        value=str(port) if key=='AGENT_PORT' else json.dumps(config[key],ensure_ascii=False)
        header+=f'#define {key} {value}\n'
    header+=f'#define AGENT_PORT_STR {json.dumps(str(port))}\n#endif\n'
    write_private(OUTPUT_FILE,header)
    print('Configuración WiFi preparada; credenciales omitidas.')


def sync_sdkconfig(config,project_dir=PROJECT_DIR):
    settings={
        'CONFIG_ESP_WIFI_SSID':config['WIFI_SSID'],
        'CONFIG_ESP_WIFI_PASSWORD':config['WIFI_PASSWORD'],
        'CONFIG_MICRO_ROS_AGENT_IP':config['AGENT_IP'],
        'CONFIG_MICRO_ROS_AGENT_PORT':config['AGENT_PORT'],
    }
    lines={key:f'{key}={json.dumps(value,ensure_ascii=False)}' for key,value in settings.items()}
    # Defaults cover first builds; updating sdkconfig covers existing workspaces.
    write_private(Path(project_dir)/'.wifi-sdkconfig.defaults','\n'.join(lines.values())+'\n')
    sdk=Path(project_dir)/'sdkconfig'
    if sdk.exists():
        text=sdk.read_text()
        for key,line in lines.items():
            pattern=rf'^{key}=.*$'
            if re.search(pattern,text,re.M):
                text=re.sub(pattern,lambda _:line,text,flags=re.M)
            else:
                text+='\n'+line+'\n'
        write_private(sdk,text)


if __name__=='__main__':
    try:
        config=parse_env_file(ENV_FILE)
        generate_header(config)
        sync_sdkconfig(config)
    except (OSError,ValueError,SyntaxError) as error:
        print(f'No se pudo preparar WiFi ({type(error).__name__}); verifica .env.',file=sys.stderr)
        raise SystemExit(1)
