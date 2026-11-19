import os
from pathlib import Path
from dotenv import load_dotenv
ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / 'monitoring' / '.env')
load_dotenv(ROOT / 'database' / '.env')
GATEWAY = os.getenv('GATEWAY_ID', 'lab-pc')
SQLITE_PATH = os.getenv('MONITOR_SQLITE', str(ROOT / '.monitoring' / 'gateway.sqlite3'))
MONGO_URI = os.getenv('MONGO_URI')
MONGO_DB = os.getenv('MONGO_DB', 'Microalgas-lab')
PREFIX = os.getenv('MONITOR_COLLECTION_PREFIX', 'monitor_v1_')

# Empty permits all devices; configure each gateway explicitly when isolating a bench module.
DEVICE_IDS=frozenset(x.strip() for x in os.getenv('MONITOR_DEVICE_IDS','').split(',') if x.strip())

def accepts_device(device_id):
    return not DEVICE_IDS or device_id in DEVICE_IDS
