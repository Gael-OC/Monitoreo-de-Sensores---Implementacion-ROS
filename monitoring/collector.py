"""python -m monitoring.collector (requires the ROS 2 environment)."""
import logging
import threading
from . import config
from .model import analog_adapter
from .store import Store
from .mongo import Central

def main():
    import os
    os.environ.setdefault('ROS_AUTOMATIC_DISCOVERY_RANGE','LOCALHOST')
    import rclpy
    from std_msgs.msg import Float32MultiArray
    store=Store(config.SQLITE_PATH)
    central=Central()
    stop=threading.Event()
    thread=threading.Thread(target=central.worker,args=(store,stop),daemon=True)
    thread.start()
    rclpy.init()
    node=rclpy.create_node('monitoring_collector_v1')
    def receive(message):
        try:
            value=analog_adapter(message.data,config.GATEWAY)
            if config.accepts_device(value['device_id']):
                store.ingest(value)
        except (ValueError,TypeError,KeyError) as error:
            node.get_logger().warning(f'Mensaje rechazado: {error}')
        except Exception:
            node.get_logger().error('No se pudo persistir la lectura local; revisar disco y permisos')
            raise
    subscription=node.create_subscription(Float32MultiArray,'/sensor_data',receive,10)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        thread.join(timeout=8)
        node.destroy_node()
        rclpy.shutdown()
        if central.client is not None:
            central.client.close()

if __name__=='__main__':
    logging.basicConfig(level=logging.INFO)
    main()
