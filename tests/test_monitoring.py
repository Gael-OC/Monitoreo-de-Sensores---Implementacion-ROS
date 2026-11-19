import csv
import io
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime,timezone,timedelta
from unittest.mock import patch
from monitoring.model import analog_adapter,reading
from monitoring.store import Store

class MonitoringTests(unittest.TestCase):
    def setUp(self):
        from monitoring import config
        device_patch=patch.object(config,'DEVICE_IDS',frozenset())
        device_patch.start()
        self.addCleanup(device_patch.stop)
        mongo_patch=patch.object(config,'MONGO_URI',None)
        mongo_patch.start()
        self.addCleanup(mongo_patch.stop)
        self.tmp=tempfile.TemporaryDirectory()
        self.store=Store(Path(self.tmp.name)/'db.sqlite')
        self.start=datetime(2026,11,15,12,tzinfo=timezone.utc)
    def tearDown(self):
        self.tmp.cleanup()
    def sample(self,minute=0,second=0,**kw):
        return reading('lab-pc','sensor',{'temperatura':{'value':float(minute),'unit':'°C'}},received_at=self.start+timedelta(minutes=minute,seconds=second),**kw)
    def test_analog_identity_and_validation(self):
        self.assertEqual(analog_adapter([22,8,1800,0xCC7B5C,0xF1E3CC],'lab-pc')['device_id'],'CC7B5CF1E3CC')
        for frame in ([22,float('nan'),3,1,2],[1,2,3,-1,4],[1,2,3,1.5,4],[1,2]):
            with self.assertRaises(ValueError):analog_adapter(frame,'lab-pc')
    def test_minute_selection_and_both_hour_modes(self):
        for minute in range(60):
            self.store.ingest(self.sample(minute))
            self.store.ingest(self.sample(minute,second=4))
        hour=self.store.documents('hours')[0]
        self.assertEqual(len(self.store.documents('minutes')),60)
        self.assertEqual(hour['sample_count'],60)
        self.assertEqual(hour['point']['temperatura']['value'],0)
        self.assertEqual(hour['summary']['temperatura']['mean'],29.5)
    def test_context_is_immutable_and_separate(self):
        self.store.ingest(self.sample())
        self.store.update_device('lab-pc','sensor',{'context':'culture'})
        self.store.ingest(self.sample(1))
        self.assertEqual({x['context'] for x in self.store.documents('hours')},{'dry_test','culture'})
        culture=next(x for x in self.store.documents('hours') if x['context']=='culture')
        self.assertIsNone(culture['point'])
    def test_restart_ack_race_and_no_unsynced_pruning(self):
        self.store.ingest(self.sample())
        pending=next(r for r in self.store.pending() if r[0]=='latest')
        self.store.ingest(self.sample(0,second=4))
        self.store.acknowledge(pending[0],pending[1],pending[3])
        restarted=Store(self.store.path)
        self.assertTrue(any(r[0]=='latest' for r in restarted.pending()))
        restarted.prune()
        self.assertEqual(len(restarted.documents('minutes')),1)
    def test_partial_digital_and_gap(self):
        self.store.ingest(reading('lab-pc','digital',{'oxygen':{'value':7.2,'unit':'mg/L','quality':'valid'}},received_at=self.start+timedelta(minutes=3)))
        hour=self.store.documents('hours')[0]
        self.assertIsNone(hour['point'])
        self.assertEqual(hour['summary']['oxygen']['count'],1)
        self.assertNotIn('ph',hour['summary'])
    def test_sync_retries_idempotently(self):
        from monitoring.mongo import Central
        central=Central()
        self.store.ingest(self.sample())
        replica={}
        def push(kind,doc):replica[kind,doc['_id']]=doc
        with patch.object(central,'push',side_effect=ConnectionError):
            with self.assertRaises(ConnectionError):central.sync_once(self.store)
        self.assertTrue(self.store.pending())
        with patch.object(central,'push',side_effect=push):
            central.sync_once(self.store)
            size=len(replica)
            central.sync_once(self.store)
        self.assertFalse(self.store.pending())
        self.assertEqual(size,len(replica))
    def test_bulk_failure_preserves_pending(self):
        from monitoring.mongo import Central
        from unittest.mock import Mock
        central=Central()
        central.db=object()
        central.read=lambda *args:[]
        collection=Mock()
        central.collection=lambda kind:collection
        self.store.ingest(self.sample())
        collection.bulk_write.side_effect=ConnectionError('offline')
        with self.assertRaises(ConnectionError):central.sync_once(self.store)
        self.assertTrue(self.store.pending())
        collection.bulk_write.side_effect=None
        central.sync_once(self.store)
        self.assertFalse(self.store.pending())

    def test_local_history_never_waits_for_mongo(self):
        from fastapi.testclient import TestClient
        from monitoring import api
        api.store=self.store
        self.store.ingest(self.sample())
        with patch.object(api.central,'read',side_effect=AssertionError('Must use SQLite')):
            result=TestClient(api.app).get('/api/v1/history',params={
                'gateway':'lab-pc','device':'sensor','start':self.start.isoformat(),
                'end':(self.start+timedelta(hours=1)).isoformat()})
        self.assertEqual(result.status_code,200)
        self.assertEqual(len(result.json()['records']),1)

    def test_minute_publisher_is_recent_between_messages(self):
        from monitoring import api
        from monitoring.model import utcnow
        api.store=self.store
        self.store.ingest(reading('lab-pc','slow',{'ph':{'value':7,'unit':'pH'}},received_at=utcnow()-timedelta(seconds=45)))
        self.store.update_device('lab-pc','slow',{'expected_interval_seconds':60})
        device=next(d for d in api.devices()['devices'] if d['device_id']=='slow')
        self.assertTrue(device['recent'])

    def test_device_allowlist_hides_other_module(self):
        from monitoring import api,config
        from fastapi.testclient import TestClient
        api.store=self.store
        self.store.ingest(self.sample())
        self.store.ingest(reading('lab-pc','other',{'ph':{'value':7}},received_at=self.start))
        with patch.object(config,'DEVICE_IDS',frozenset({'sensor'})):
            self.assertFalse(config.accepts_device('other'))
            self.assertEqual([d['device_id'] for d in api.devices()['devices']],['sensor'])
            self.assertEqual(TestClient(api.app).get('/api/v1/history',params={'gateway':'lab-pc','device':'other'}).status_code,404)

    def test_wifi_helper_keeps_credentials_private(self):
        import importlib.util
        from contextlib import redirect_stdout
        from types import SimpleNamespace
        root=Path(__file__).resolve().parents[1]
        spec=importlib.util.spec_from_file_location('wifi_helper',root/'scripts/configure-lab-wifi.py')
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        project=Path(self.tmp.name)/'firmware'
        target=project/'main/versions/wifi';target.mkdir(parents=True)
        (target/'generate_wifi_config.py').touch()
        output=io.StringIO()
        with patch.object(helper.os,'geteuid',return_value=0), patch.object(helper.os,'chown'), patch.object(helper.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=1000,pw_gid=1000)), patch.object(helper.sys,'argv',['helper',str(project)]), patch.object(helper,'nm',side_effect=['12345678-1234-1234-1234-123456789abc','lab-ros','example-test-password']), redirect_stdout(output):
            helper.main()
        self.assertNotIn('example-test-password',output.getvalue())
        self.assertIn('example-test-password',(target/'wifi_config.h').read_text())
        self.assertEqual((target/'.env').stat().st_mode & 0o777,0o600)

    def test_wifi_preparation_updates_sdk_before_configuration(self):
        import importlib.util
        root=Path(__file__).resolve().parents[1]
        spec=importlib.util.spec_from_file_location('wifi_generator',root/'microros-esp/main/versions/wifi/generate_wifi_config.py')
        generator=importlib.util.module_from_spec(spec);spec.loader.exec_module(generator)
        project=Path(self.tmp.name)
        env=project/'.env'
        env.write_text('WIFI_SSID="lab-ros"\nWIFI_PASSWORD="example-test-password"\nAGENT_IP="10.42.0.1"\nAGENT_PORT="8888"\n')
        sdk=project/'sdkconfig';sdk.write_text('CONFIG_ESP_WIFI_SSID="old-network"\nCONFIG_UNRELATED=y\n')
        values=generator.parse_env_file(env)
        generator.sync_sdkconfig(values,project)
        self.assertIn('CONFIG_ESP_WIFI_SSID="lab-ros"',sdk.read_text())
        self.assertIn('CONFIG_UNRELATED=y',sdk.read_text())
        previous=sdk.read_text()
        generator.sync_sdkconfig(values,project)
        self.assertEqual(previous,sdk.read_text())

    def test_api_csv_and_validation(self):
        os.environ['MONITOR_SQLITE']=str(Path(self.tmp.name)/'api.sqlite')
        from fastapi.testclient import TestClient
        from monitoring import api
        api.store=self.store
        api.central.read=lambda *args:[]
        client=TestClient(api.app)
        self.store.ingest(self.sample())
        params={'gateway':'lab-pc','device':'sensor','start':self.start.isoformat(),'end':(self.start+timedelta(hours=1)).isoformat()}
        doc=client.get('/api/v1/history',params=params).json()['records'][0]
        csv_rows=list(csv.DictReader(io.StringIO(client.get('/api/v1/export.csv',params=params).text.lstrip('\ufeff'))))
        self.assertEqual(float(csv_rows[0]['valor']),doc['measurements']['temperatura']['value'])
        self.assertEqual(client.get('/api/v1/history',params=dict(params,start='2026-11-15T12:00:00')).status_code,422)
        self.assertEqual(client.patch('/api/v1/devices/lab-pc/sensor',json={'context':'bad'}).status_code,422)
        self.assertEqual(client.patch('/api/v1/devices/lab-pc/sensor',headers={'Origin':'https://evil.example'},json={'alias':'X'}).status_code,403)

    def test_panel_and_wall_pages_are_served(self):
        from fastapi.testclient import TestClient
        from monitoring import api
        client=TestClient(api.app)
        for path,script in (('/','/static/app.js'),('/nodos','/static/app.js'),('/historial','/static/app.js'),('/pared','/static/pared.js')):
            page=client.get(path)
            self.assertEqual(page.status_code,200)
            self.assertIn('/static/comun.js',page.text)
            self.assertIn(script,page.text)
            self.assertNotIn('style=',page.text)  # CSP forbids inline styles.

if __name__=='__main__':unittest.main()
