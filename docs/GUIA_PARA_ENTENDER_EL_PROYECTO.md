# Guía para entender y retomar el proyecto

Revisión del 5 de noviembre de 2026 sobre el commit `a7d5092` (15 de mayo de 2026).

Esta guía describe lo que hace el código revisado, distingue los ejemplos antiguos del flujo actual y propone cómo estudiarlo desde un Mac. Las recomendaciones de integración son preliminares: todavía falta el repositorio digital y la definición de la entrega del profesor.

## 1. Qué problema resuelve

Es un sistema de adquisición, almacenamiento y visualización de mediciones ambientales. Un ESP32 lee un sensor que el repositorio identifica como **CWT-BL**, con dos salidas analógicas: temperatura y pH. Envía las mediciones por WiFi a un computador o Raspberry Pi. Ese equipo las recibe mediante micro-ROS, las expone en ROS 2 y ejecuta un programa Python que las guarda en MongoDB.

Otros programas consultan MongoDB para mostrar gráficos, administrar dispositivos o enviar alertas y resúmenes por Telegram. Además, el firmware permite controlar motores DC desde ROS 2.

Los nombres, imágenes y textos sugieren un uso en monitoreo de agua y cultivos de microalgas. **El objetivo experimental exacto y la función física de los motores deben confirmarse con el profesor.** El código no identifica suficientemente el montaje para asegurar, por ejemplo, que los motores sean agitadores o bombas.

No se encontró un controlador que tome decisiones sobre los motores a partir del pH o la temperatura. Actualmente conviven monitoreo y órdenes manuales de motor.

## 2. El recorrido de una medición

```text
AGUA / MEDIO QUE SE ESTÁ MIDIENDO
             │
             ▼
Sensor CWT-BL: salidas de voltaje para pH y temperatura
             │  acondicionamiento eléctrico a confirmar
             ▼
ESP32: GPIO36 para pH y GPIO39 para temperatura
             │
             ├─ ADC: convierte voltaje en números
             ├─ Mediana de hasta 10 muestras por lectura
             ├─ Conversión a °C y pH con calibración
             └─ Publicación cada ~4 segundos
             │
             ▼ WiFi / UDP, puerto habitual 8888
micro-ROS Agent, en el equipo receptor
             │ convierte entre XRCE-DDS y ROS 2
             ▼
Topic ROS 2 /sensor_data
             │
             ▼
database/ros_sensor_node.py, también en el receptor
             ├─ Reconstruye la MAC para identificar el ESP32
             ├─ Conserva el último dato de cada dispositivo
             └─ Cada 5 s intenta guardar datos con menos de 10 s de edad
             │
             ▼
MongoDB: sensors_data + devices_data
             │
             ├─ Dashboard Streamlit: gráficos e historial
             ├─ smart_alerter.py: alertas Telegram
             └─ smart_reporter.py: resúmenes Telegram
```

**Los tres lugares de ejecución son diferentes:** el firmware C corre en el ESP32; el Agent y el puente Python corren en Linux; el panel puede correr en otro computador o servidor porque lee MongoDB. El dashboard no recibe directamente la señal del sensor ni se suscribe a ROS.

### Vocabulario mínimo

| Concepto | Qué significa aquí |
|---|---|
| Sensor analógico | Entrega una magnitud representada por un voltaje. |
| ADC | Convertidor analógico-digital dentro del ESP32. Produce una cuenta que luego se convierte a voltaje. |
| Sensor digital | Entrega datos mediante algún protocolo, por ejemplo 1-Wire, I²C, SPI o UART. Hay que saber cuál usa el otro proyecto. |
| Firmware | Programa compilado que se graba en el microcontrolador. |
| ESP-IDF | Herramientas y bibliotecas de Espressif utilizadas para compilar este firmware. |
| FreeRTOS | Sistema que organiza tareas dentro del ESP32. |
| ROS 2 | Infraestructura para comunicar programas mediante mensajes; no reemplaza macOS ni Ubuntu. |
| Nodo | Programa participante de ROS. Aquí hay nodos en el ESP32 y en Python. |
| Topic | Canal identificado por un nombre y un tipo de mensaje. Publicadores envían; suscriptores reciben. |
| micro-ROS | Adaptación para microcontroladores, utilizada por el ESP32. |
| Agent | Proceso que conecta el cliente micro-ROS con el entorno ROS 2 del receptor. No es una IA. |
| Gateway | Equipo que recibe las mediciones y las lleva hacia la base de datos. |
| MongoDB Atlas | Servicio alojado de MongoDB. El código también permite una URI de MongoDB local. |
| Calibración | Relación entre señal y medición, o corrección respecto de una referencia conocida. |

Que un sensor sea analógico o digital cambia principalmente **cómo se obtiene su lectura**. Una vez que existe un valor con unidad, fecha, identidad y estado de validez, puede circular por la misma infraestructura.

## 3. Qué parte del repositorio está activa

El archivo decisivo es `microros-esp/main/CMakeLists.txt`: enumera los archivos C que realmente se compilan.

| Ruta | Responsabilidad y estado |
|---|---|
| `README.md` | Panorama general; contiene algunos valores y afirmaciones que no coinciden con el código actual. |
| `microros-esp/main/versions/wifi/src/main.c` | Inicio y bucle de la aplicación del ESP32. Activo. |
| `…/sensor_manager_filtered.c` | Lectura analógica, mediana y conversiones. Activo. |
| `…/sensor_manager.c` | Otra implementación de lectura; **no está seleccionada** en el CMake actual. |
| `…/ros_publisher.c` | Mensajes de sensores, recepción de órdenes y recuperación de sesión. Activo. |
| `…/network_manager.c` | Inicio WiFi y monitor de reconexión. Activo. |
| `…/motor_controller.c` | PWM y selección de dos motores. Activo. |
| `microros-esp/main/versions/wifi/include/config.h` | Pines, calibración, intervalos y parámetros de tareas. |
| `microros-esp/main/versions/wifi/.env` | Credenciales WiFi y dirección del Agent; falta en esta copia y no debe versionarse. |
| `microros-esp/main/Motores/motor_control_node.py` | Control manual por teclado desde el equipo con ROS. |
| `microros-esp/components/micro_ros_espidf_component/` | Dependencia micro-ROS incluida, con sus propios ejemplos y licencias. No es el código principal de sensores. |
| `database/ros_sensor_node.py` | Puente vigente entre `/sensor_data` y MongoDB. |
| `database/modules/config.py` | Carga `database/.env`. |
| `database/modules/service.py` | Guardado, offsets, registro y metadatos de dispositivos. |
| `database/modules/crear_colecciones.py` | Herramienta para crear colecciones e índices. Modifica la BD al ejecutarla. |
| `scripts/start_agent.sh`, `scripts/start_bridge.sh` | Lanzadores Linux del Agent y del puente. |
| `services/*.service.tpl` | Plantillas de servicios systemd usadas por el menú. |
| `systemd/smart-alerter.service` | Archivo con rutas de una instalación específica del usuario `microalgas`; no es portable. |
| `scripts/telegram/` | Alertas y reportes que consultan MongoDB. |
| `install.sh`, `menu.sh`, `scripts/status.sh`, `scripts/firewall.sh` | Instalación, operación y configuración del gateway Linux. |
| `legacy/main/` | Dashboard Streamlit disponible en esta copia, aunque fue movido a `legacy`. |
| `legacy/analisis/` | Análisis, imágenes y datos históricos; no forman parte de la adquisición actual. |
| `legacy/versiones esp/` | Firmware y suscriptores antiguos, incluyendo ejemplos digitales DS18B20. |
| `microros-esp/scripts/sensor_to_mongodb.py` | Puente anterior: usa `/temperatura` y `/ph` separados y otro esquema de datos. No sustituye al puente vigente. |
| `microros-esp/main/esp32_serial_transport.*` | Código de transporte serie que no se incluye en la compilación WiFi actual. |

Las guías antiguas en `microros-esp/docs/` hablan de transporte serie, tópicos separados y opciones de menú anteriores. Sirven como historia y explicación, pero sus comandos no deben asumirse vigentes.

## 4. Cómo funciona el ESP32

### Inicio

`app_main()` en `main.c` hace lo siguiente:

1. Inicializa WiFi con la función auxiliar del componente micro-ROS.
2. Inicia una tarea que revisa la conexión de red.
3. Configura ADC1 y los canales de temperatura y pH.
4. Hace una lectura inicial para los logs.
5. Inicializa ambos controladores de motor, con PWM inicial en cero.
6. Crea la tarea de micro-ROS en el núcleo 1. El monitor WiFi se ubica en el núcleo 0.

La tarea ROS espera al Agent, crea sus entidades, procesa órdenes y lee/publica sensores cuando corresponde. El período de publicación configurado es **4000 ms**, aproximadamente **0,25 Hz**; no es un sistema de adquisición de alta frecuencia.

### Señal analógica, filtrado y conversión

Para cada lectura se intentan hasta diez conversiones ADC. Se ordenan las muestras exitosas y se toma su mediana; si son pares, se promedian las dos centrales. Esto reduce el efecto de picos aislados, pero no demuestra que la lectura esté bien calibrada o que el sensor esté conectado.

El firmware intenta usar la calibración de ADC de ESP-IDF para obtener milivoltios. Si no está disponible, aproxima con `raw × 3300 / 4095`.

Las fórmulas activas son:

```text
Temperatura (°C) = (V_adc_mV / 1000) × (5 / 3,3) × 20 − 20 − 0,7
pH              = limitar(V_adc_mV × 0,003810 + 0,505609, 0, 14)
```

Ejemplo puramente matemático: con 1500 mV se obtendrían aproximadamente **24,75 °C** en el canal de temperatura y **6,22 pH** en el canal de pH. Son señales distintas; no implica que ambos canales deban entregar el mismo voltaje.

El factor `5 / 3,3` supone una relación eléctrica que hay que comprobar en el montaje. **Multiplicar en software no protege un pin frente a sobretensión.** El README describe salidas de hasta 5 V y también advierte que se debe verificar el divisor o acondicionamiento antes de conectarlas al ESP32. Pide el esquema real, sus resistencias y la ficha técnica; el rango útil del ADC tampoco debe confundirse con el límite eléctrico del pin.

Se usa ADC1. La documentación de Espressif explica que ADC2 se comparte con WiFi; este detalle ayuda a entender la elección, aunque la intención del autor no está documentada explícitamente. [Referencia oficial ADC](https://docs.espressif.com/projects/esp-idf/en/v5.4.1/esp32/api-reference/peripherals/adc_oneshot.html).

### Calibración en dos lugares

Hay dos mecanismos distintos:

- **Firmware:** pendiente e intercepto de pH y un offset de temperatura en `config.h`. Cambiarlos requiere compilar y grabar el firmware.
- **Base de datos:** offsets por dispositivo que `SensorDBService.guardar_lectura()` suma antes de guardar. Cambiarlos afecta a nuevas lecturas guardadas, no modifica el firmware ni recalcula el historial existente.

La herramienta `microros-esp/scripts/utils/calibracion_ph.py` permite seleccionar la MAC, capturar diez mensajes de estabilización y treinta de medición por solución, calcular una regresión y mostrar las constantes para copiar a `config.h`. A cuatro segundos por mensaje, la captura completa de un punto toma aproximadamente 160 segundos, sin contar estabilización física e interacción. No escribe automáticamente la nueva pendiente en el ESP32.

La señal `voltage_raw_ph` es **voltaje filtrado en milivoltios**, no la cuenta ADC original. Además, pH y voltaje se obtienen mediante dos tandas de lecturas separadas; no son necesariamente una misma muestra exacta.

### Recuperación de conexión

Hay un monitor WiFi y una comprobación periódica del Agent. Si este deja de responder, el firmware intenta destruir y recrear las entidades ROS. El monitor de red contempla reiniciar el ESP32 tras un umbral nominal de desconexión; su contador no incluye todo el tiempo de espera de cada reconexión, por lo que no debe interpretarse como un plazo exacto de 90 segundos.

Estas rutas existen en el código, pero no se validaron con desconexiones de hardware durante esta revisión.

## 5. El contrato de datos ROS: clave para integrar

El topic actual es `/sensor_data`, con tipo `std_msgs/msg/Float32MultiArray`. Su contenido está definido por posición:

| Índice | Significado | Unidad / representación |
|---|---|---|
| 0 | Temperatura | °C ya convertidos por el firmware |
| 1 | pH | pH ya convertido por el firmware |
| 2 | Voltaje de pH | mV filtrados, antes de la conversión a pH |
| 3 | Primera mitad de la MAC | Primeros 24 bits, codificados como un float |
| 4 | Segunda mitad de la MAC | Últimos 24 bits, codificados como un float |

Ejemplo inventado: `[25.0, 7.0, 1700.0, 11189196.0, 14544639.0]` identifica la MAC `AABBCCDDEEFF`. El receptor convierte cada mitad a entero y la formatea como seis dígitos hexadecimales. Estas mitades caben exactamente en la precisión entera de Float32.

El mensaje no contiene nombre de sensor, unidad explícita, versión, fecha de adquisición, número de secuencia ni indicador de fallo. Su interpretación depende de que emisor y receptor conozcan el mismo orden.

**No sirve insertar simplemente una nueva lectura en cualquier posición.** Si se inserta antes de la MAC, el puente puede identificar mal al dispositivo. Si se agrega después del quinto elemento, el puente actual acepta el mensaje pero ignora el nuevo dato. Será necesario acordar un contrato con el otro repositorio.

## 6. Qué guarda MongoDB

`ros_sensor_node.py` conserva en memoria el último par temperatura/pH de cada MAC. Cada cinco segundos, si ese par llegó hace menos de diez segundos, llama al servicio de guardado.

Por tanto, no archiva necesariamente cada publicación: puede saltarse publicaciones entre ciclos y también guardar de nuevo una misma recepción. La fecha guardada es la del guardado en el gateway, **no una fecha enviada por el ESP32**.

Ejemplo del esquema actual, con fecha representada como texto para facilitar la lectura:

```json
{
  "timestamp": "2026-11-05T15:00:00Z",
  "dispositivo_id": "AABBCCDDEEFF",
  "datos": {
    "temperatura": 25.0,
    "ph": 7.0
  }
}
```

En MongoDB, `timestamp` es una fecha BSON. Los valores se guardan redondeados a dos decimales después de aplicar los offsets por dispositivo. El voltaje de pH no se guarda por el puente vigente.

La segunda colección contiene metadatos por MAC: nombre, estado, ubicación, calibración, sensores habilitados y estadísticas de conexión. El autorregistro pone el dispositivo en estado `pendiente`; ese estado no impide que el puente guarde sus datos. Tampoco cambiar `intervalo_lectura_seg` en la BD cambia los cuatro segundos configurados en el firmware: son campos sin una ruta de configuración de vuelta al ESP32.

La herramienta `crear_colecciones.py` crea `sensors_data` como Time Series y `devices_data` como colección de metadatos. **El puente no ejecuta esa preparación:** no basta con arrancarlo para garantizar que la colección tenga la estructura Time Series y los índices previstos. Si la colección ya existe, la herramienta omite su creación y no verifica que tenga la configuración deseada.

En `database/.env` conviene declarar explícitamente todos los nombres, porque los valores de respaldo del código difieren de la plantilla:

```dotenv
MONGO_URI=<URI de la base de desarrollo>
MONGO_DB=Datos_ESP
MONGO_COLLECTION=sensors_data
MONGO_COLLECTION_DISPOSITIVOS=devices_data
```

El esquema está explicado también en `docs/SCHEMA_MONGODB.md`.

## 7. Panel, alertas y motores

### Dashboard

La aplicación disponible está en `legacy/main/app.py`. Tiene cuatro pestañas: monitoreo en vivo, análisis estadístico, registros y dispositivos. Muestra temperatura/pH, series temporales, histogramas y exportación de registros. La vista en vivo usa fragmentos de Streamlit para refrescar cada diez segundos.

El README habla de un despliegue en Streamlit Cloud y autenticación, pero **no se verificó un despliegue externo y no se encontró un flujo de autenticación en esta aplicación**. Pide el enlace y confirma si existe otro repositorio para el panel vigente.

El cargador exige que una fila tenga temperatura **y** pH; un dispositivo digital que solo mida temperatura sería descartado por esa ruta. Es uno de los cambios que habrá que considerar al unificar.

### Telegram

`smart_alerter.py` consulta MongoDB cada diez segundos. Requiere umbrales mínimo y máximo y espera quince lecturas consecutivas fuera de rango antes de avisar. Luego usa un margen de retorno para evitar repetir avisos cerca del límite. Con guardado ideal cada cinco segundos, quince lecturas equivalen a alrededor de 75 segundos; no es una garantía temporal exacta.

`smart_reporter.py` genera estadísticas de ventanas de doce horas cuando se ejecuta con `--daily`. Telegram no es necesario para probar la lectura ni ROS.

### Motores

El firmware configura dos motores:

| Motor | IN1 | IN2 | Enable |
|---|---|---|---|
| 1 | GPIO25 | GPIO26 | GPIO14 |
| 2 | GPIO27 | GPIO33 | GPIO32 |

Recibe `LEFT`, `RIGHT`, `STOP`, `SPEED_SET_XX` y `SELECT_MOTOR_1/2` en `/motor_commands`, tipo `std_msgs/msg/String`. El código de teclado publica esas órdenes.

Hay limitaciones relevantes para una demostración física:

- Todos los ESP32 usan el mismo topic de órdenes sin destinatario: una orden puede actuar en todos los conectados al mismo entorno ROS.
- Cambiar de motor activo no detiene el anterior, y `STOP` detiene solo el seleccionado.
- No hay una parada automática implementada al perder el Agent o dejar de recibir órdenes.
- `motor_set_speed()` actualiza la velocidad almacenada; hace falta reaplicar una dirección para cambiar el PWM de un motor que ya gira. El programa de teclado hace esa reaplicación.
- La salida del programa de teclado no garantiza detener todos los motores; su tecla Q solo termina el hilo de lectura.

Esto importa si el profesor espera incorporar actuación, pero no impide comenzar estudiando solo la adquisición.

## 8. Qué puedes hacer desde tu Mac

### Estado observado en esta sesión

- macOS sobre `arm64`.
- `python3` apunta a Python 3.14.6; no debe confundirse con el Python usado por ROS en Ubuntu.
- Hay Git, Homebrew y CMake; existe un ejecutable Docker, sin comprobar motor ni contenedores.
- `ros2`, `idf.py`, `colcon` y `ninja` no aparecen en el PATH consultado. Tampoco existe `/opt/ros/jazzy/setup.bash`.
- No existen `database/.env`, el `.env` WiFi, `sdkconfig`, `sdkconfig.defaults` ni `dependencies.lock` en esta copia.

Esto describe el entorno consultado, no descarta instalaciones en otros entornos, máquinas virtuales o equipos remotos.

### Opciones de trabajo

| Modalidad | Qué permite | Qué hace falta |
|---|---|---|
| Mac, sin instalar nada | Leer y seguir el código, estudiar mensajes y examinar JSONL históricos con Python estándar. | Esta copia y Python. |
| Mac, solo dashboard | Consultar datos históricos/actuales desde MongoDB sin ejecutar ROS. | Entorno Python compatible, dependencias, acceso a una BD y ajustes de configuración del panel. |
| Mac + gateway del laboratorio por SSH | Editar desde tu Mac y ejecutar Agent/puente en el Linux que recibe sensores. | Equipo Ubuntu, usuario/acceso y conectividad autorizada al laboratorio. |
| Máquina virtual Ubuntu 24.04 ARM64 en el Mac | Practicar ROS, mensajes simulados y puente; después recibir ESP32 reales. | Recursos para la VM y configuración de red que permita llegar por UDP al Agent. |
| ESP-IDF nativo en el Mac | Compilar/grabar el ESP32 por USB. | Entorno ESP-IDF compatible y preparación del proyecto; adaptar las utilidades dependientes de Linux. |

**Recomendación para este proyecto:** pedir acceso al gateway ya funcional del laboratorio y, si necesitas independencia, usar Ubuntu 24.04 ARM64 en una VM. Ubuntu 24.04 tiene soporte principal para Jazzy en ARM64; la matriz oficial no da ese mismo soporte a macOS ARM64. Esta recomendación se basa en esa compatibilidad y en los scripts concretos del repo. [Matriz oficial REP-2000](https://github.com/ros-infrastructure/rep/blob/master/rep-2000.rst#jazzy-jalisco-may-2024---may-2029).

ESP-IDF sí dispone de instrucciones para macOS y puertos `/dev/cu.*`. Eso no vuelve compatibles automáticamente el menú y el instalador de este proyecto: utilizan `apt`, `systemctl`, `getent`, `ip`, `iptables`, `fuser`, nombres de puertos Linux y variantes GNU de herramientas. [Guía oficial ESP-IDF 5.4.1](https://docs.espressif.com/projects/esp-idf/en/v5.4.1/esp32/get-started/linux-macos-setup.html).

En una VM, una práctica totalmente simulada puede funcionar sin recibir tráfico del exterior. Para un ESP32 real, `AGENT_IP` debe apuntar a una dirección alcanzable del receptor Linux; una VM con NAT puede necesitar redirección UDP o una configuración de red diferente. Esto se prueba en la red concreta. Mantener Agent y puente dentro de la misma VM conserva el aislamiento `LOCALHOST` de ROS que usa el proyecto.

En el gateway actual, `ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST` restringe el descubrimiento ROS al mismo equipo. No impide que el ESP32 llegue por UDP al Agent. Sí significa que ejecutar un suscriptor ROS directamente en tu Mac no permite ver automáticamente los topics del Linux remoto; puedes usar SSH para ejecutar los comandos allí.

## 9. Ruta de aprendizaje y pruebas por etapas

### Etapa A: entender sin hardware ni cuentas

Lee estos archivos en este orden y responde la pregunta asociada:

1. `microros-esp/main/CMakeLists.txt`: ¿qué versión se compila realmente?
2. `…/include/config.h`: ¿qué pines y constantes están activos?
3. `…/src/main.c`: ¿quién arranca cada tarea y con qué frecuencia lee?
4. `…/src/sensor_manager_filtered.c`: ¿cómo convierte señal en magnitud?
5. `…/src/ros_publisher.c`: ¿cómo construye los cinco números?
6. `database/ros_sensor_node.py`: ¿cómo identifica y selecciona qué guardar?
7. `database/modules/service.py`: ¿qué calibración adicional aplica?
8. `legacy/main/database/mongo_handler.py`: ¿qué documentos acepta el panel?
9. `scripts/telegram/smart_alerter.py`: ¿qué condiciones activan un aviso?

Los JSONL históricos están en `legacy/analisis/datos_sensores/`: un documento JSON por línea. Son del esquema anterior, sin identidad de dispositivo. No son una copia directa de los documentos nuevos de `sensors_data`.

Ejercicio ya verificado, sin dependencias adicionales: desde la raíz del repositorio, ejecutar lo siguiente para contar registros y detectar líneas inválidas.

```bash
python3 - <<'PY'
import json
from pathlib import Path

for archivo in sorted(Path('legacy/analisis/datos_sensores').glob('*.jsonl')):
    validas = invalidas = 0
    for linea in archivo.open():
        try:
            json.loads(linea)
            validas += 1
        except json.JSONDecodeError:
            invalidas += 1
    print(archivo.name, 'válidas:', validas, 'inválidas:', invalidas)
PY
```

Se encontraron **117.336 registros válidos** en seis archivos y **18 líneas inválidas**, todas en el del 14 de enero. Algunas temperaturas históricas llegan a valores negativos o picos altos; no hay información suficiente para atribuirlos a condiciones reales, fallos o calibración. Úsalos para aprender limpieza y estructura, no como referencia de exactitud del montaje actual.

### Etapa B: aprender ROS sin conectar sensores

En un Ubuntu con ROS 2 Jazzy instalado, cada terminal de la práctica debe cargar ROS y usar el mismo alcance de descubrimiento:

```bash
source /opt/ros/jazzy/setup.bash
export ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST
```

Terminal 1:

```bash
ros2 topic echo /sensor_data
```

Terminal 2:

```bash
ros2 topic pub /sensor_data std_msgs/msg/Float32MultiArray \
  '{data: [25.0, 7.0, 1700.0, 11189196.0, 14544639.0]}' --rate 0.25
```

Terminal 3:

```bash
ros2 topic info /sensor_data
ros2 topic hz /sensor_data
```

Resultado esperado: aparece el array y la frecuencia se aproxima a 0,25 Hz tras varias muestras. **Esta práctica ROS no necesita micro-ROS Agent**, porque el publicador ya es un proceso ROS normal. El Agent se incorpora cuando el emisor es el ESP32 con micro-ROS.

Estos comandos son una práctica propuesta; no se ejecutaron aquí porque falta ROS.

### Etapa C: probar el puente con datos simulados

Usa una base de desarrollo, sin alertador ni reportes activos. El puente registra automáticamente la MAC de ejemplo y escribe mediciones cuando se conecta a la BD configurada.

1. Preparar `database/.env` con los cuatro valores de MongoDB.
2. Instalar las dependencias del puente en el Python compatible con ROS (`pymongo` y `python-dotenv`; ROS aporta `rclpy` y `std_msgs`).
3. Si se quiere Time Series, preparar explícitamente las colecciones en esa BD con `database/modules/crear_colecciones.py`, antes de la primera inserción.
4. Mantener el publicador simulado de la etapa B.
5. En otra terminal con ROS cargado, ejecutar `python3 database/ros_sensor_node.py` desde la raíz.
6. Comprobar en MongoDB el dispositivo `AABBCCDDEEFF` y los valores guardados aproximadamente cada cinco segundos.

Esta etapa permite entender el almacenamiento sin depender de ADC, WiFi del ESP32 ni calibración física. No valida esos componentes.

### Etapa D: usar el hardware real

1. Obtener placa, sensor, esquema, acondicionamiento y alimentación confirmados.
2. Preparar un entorno ESP-IDF compatible con la referencia del proyecto, v5.4.1.
3. Pedir la configuración efectiva de una compilación que funcione; en la copia faltan archivos de configuración y bloqueo de dependencias.
4. Crear el `.env` WiFi con `WIFI_SSID`, `WIFI_PASSWORD`, `AGENT_IP` y `AGENT_PORT`.
5. Compilar primero y revisar el resultado. Grabar después sobre la placa destinada a la prueba.
6. En Linux, iniciar `ros2 run micro_ros_agent micro_ros_agent udp4 --port 8888` con el workspace del Agent cargado. Ajustar el puerto si corresponde.
7. Confirmar `/sensor_data` con `ros2 topic echo` antes de sumar MongoDB o el panel.
8. Conectar el puente y verificar lecturas en BD.
9. Calibrar contra referencias, no solamente comprobar que llegan números.
10. Incorporar panel, Telegram y actuación cuando cada etapa anterior esté entendida.

El acceso directo `build + flash` del repo ejecuta también **`erase_flash`**, borrando toda la flash antes de grabar. Conviene conocerlo y obtener la configuración de la placa existente antes de usarlo.

### Etapa E: dashboard en Mac

No necesita ROS ni un ESP32 si hay datos accesibles en MongoDB. La ruta de arranque disponible es `legacy/main/app.py`. Usa un entorno aislado compatible con sus dependencias; Python 3.12 es una referencia coherente con la documentación del proyecto, pero no se verificó aquí la instalación del panel.

La carga de `database/.env` en `legacy/main/config/settings.py` quedó apuntando a `legacy/database/.env`, no a la carpeta `database/` de la raíz. Hay que corregir esa ruta o suministrar las variables por el entorno/los secrets de Streamlit. Después de preparar dependencias y configuración, el comando es `streamlit run legacy/main/app.py` desde la raíz.

Los datos de enero no aparecerán en la vista inicial de la última hora. Además, la aplicación actual oculta todas sus pestañas si la consulta inicial está vacía; para una prueba histórica se necesita ajustar el rango/flujo o una base de prueba con fechas apropiadas.

## 10. Hallazgos que conviene conocer antes de instalar o integrar

Son problemas observados por lectura y comprobaciones locales, no todos fallos reproducidos en el montaje. No se modificó el código de funcionamiento.

| Impacto | Hallazgo y evidencia | Consecuencia |
|---|---|---|
| Montaje | README describe señal 0–5 V y conversión de temperatura supone escalamiento (`sensor_manager_filtered.c:71`). Falta esquema eléctrico. | Confirmar acondicionamiento y calibración antes de conectar el sensor. |
| Calidad de datos | Si todas las conversiones ADC fallan se devuelve 0 °C o pH 7 (`sensor_manager_filtered.c:173,218`). | Un error de lectura puede parecer una medición válida. Una desconexión física también puede producir cuentas ADC exitosas; no hay detección suficiente de esa condición. |
| Calidad de datos | Temporizador guarda el último dato de menos de 10 s, cada 5 s (`ros_sensor_node.py:175`). | No hay correspondencia uno a uno entre publicación e inserción. Se reprodujo el guardado repetido de una sola recepción. |
| Recuperación | `_conectar_mongodb()` se invoca al inicio; si falla, `_db_available` queda falso y no existe un intento periódico que lo vuelva verdadero (`ros_sensor_node.py:64,88`). | Si MongoDB no está disponible al arrancar, el nodo puede seguir recibiendo sin volver a guardar hasta reiniciarlo. No hay cola persistente ni respaldo local en el puente vigente. |
| Recuperación | `destroy_node()` usa `self.db.cerrar()` aunque `self.db` puede ser `None` (`ros_sensor_node.py:225`). | El cierre puede fallar cuando no se logró construir el servicio de BD. |
| Configuración | Código usa respaldos `data_sensors/data_devices`; plantilla y creador usan `sensors_data/devices_data` (`database/modules/config.py:23`). | Declarar ambos nombres explícitamente para evitar leer/escribir colecciones distintas. |
| Configuración | Metadatos dicen intervalo de 60 s, firmware 4 s y puente 5 s. | Los metadatos no representan necesariamente la frecuencia real ni configuran el ESP32. |
| Calibración | README muestra pendiente/intercepto `0.003780/1.152729`; código activo `0.003810/0.505609`. | Pedir qué calibración corresponde a cada sensor físico; usar el código como referencia de lo que se compila. |
| Telegram | Cron llama al reportero sin `--daily` (`menu.sh:689`), pero solo ejecuta `generar_reporte()` con ese argumento (`smart_reporter.py:92`). | Los reportes programados por ese menú no se generan. |
| Telegram | Panel escribe `temp_max`; adaptador genera `temp`, pero alertador busca `temperature`; además exige mínimo y máximo (`dispositivos.py:118`, `smart_alerter.py:93`). | La configuración de temperatura del panel no activa las alertas de temperatura como se espera. El registro inicial tampoco crea umbrales. |
| Dashboard | Ruta `.env` quedó un nivel corta tras moverlo a `legacy` (`config/settings.py:9`). | Puede no encontrar credenciales aunque estén en `database/.env` de la raíz. |
| Dashboard | Botón Actualizar llama a `MongoHandler.limpiar_cache()`, que no está definido (`components/sidebar.py:28`). | Ese botón produce un error. |
| Dashboard | Consultas requieren temperatura y pH, colección de dispositivos está fijada a `devices_data`; consulta inicial usa `datetime.now()` frente a fechas UTC. | Hay supuestos que afectan dispositivos parciales, nombres configurables y ventanas temporales en un equipo con hora local chilena. |
| Actuación | Topic común y sin parada global/de emergencia por pérdida de comunicación. | Verificar direccionamiento y condiciones de parada antes de usar varios nodos y motores. |
| Instalación | `install.sh` instala dependencias del puente, pero no declara todas las de Telegram, como `requests` y `pandas`. El menú ejecuta el instalador sin elevar todo el script y este usa `usermod` sin `sudo`. | En un Ubuntu limpio hay rutas de instalación que pueden requerir ajustes; el README no garantiza una instalación completa. |
| Reproducibilidad | No hay lock de dependencias de IDF ni `sdkconfig.defaults` versionado; `ds18b20/onewire_bus` usan `*` y las fuentes micro-ROS se clonan por ramas. | Una compilación futura puede resolver versiones distintas; pedir el entorno que funciona antes de actualizar componentes. |

Los tres archivos `legacy/main/styles/custom_css_*.py` que comienzan con `/*` contienen **CSS**, leído como texto por las páginas. Un analizador de Python los rechaza, pero eso no prueba que el dashboard falle por importarlos: no se importan como Python. Es una extensión engañosa, distinta de los problemas de ejecución anteriores.

El instalador comprueba específicamente `ID=ubuntu`; por tanto, la afirmación del README de que su instalación funciona directamente en Raspberry Pi OS no coincide con esa comprobación. Para mantener el flujo previsto en una Raspberry Pi, la referencia es **Ubuntu 24.04 de 64 bits**, no asumir equivalencia entre ambos sistemas.

## 11. Qué pedirle al profesor

### Para entender y reproducir este proyecto

1. **Montaje real:** foto, esquema y ficha técnica exacta del sensor CWT-BL; modelo de ESP32 y correspondencia de cables/pines.
2. **Material para préstamo:** placa ya usada en el proyecto, sensor con su acondicionamiento, cable USB de datos, alimentación y multímetro. Buffers de pH y referencia de temperatura si se requiere calibrar.
3. **Gateway que funciona:** ¿PC o Raspberry Pi?, sistema y versión, cómo acceder por SSH, quién lo administra y qué versión de código ejecuta.
4. **Configuración reproducible:** commit/rama de referencia, versión exacta ESP-IDF, `sdkconfig` o configuración equivalente depurada de secretos, versiones resueltas de componentes y procedimiento de compilación probado.
5. **Base de desarrollo:** URI suministrada de forma privada, nombres reales de BD/colecciones y un usuario propio con permisos apropiados. Alternativa: exportación anonimizada y permiso para usar una instancia local.
6. **Red:** SSID y credenciales por canal privado, IP del gateway, puerto UDP, si usa hotspot y si hay aislamiento entre clientes que impida comunicarse.
7. **Calibración vigente:** constantes, fecha, placa/sonda a que corresponden, resistencias de acondicionamiento y offsets almacenados en BD.
8. **Panel vigente:** enlace de la aplicación y repositorio/rama donde se mantiene. Confirmar si `legacy/main/` es solo referencia.
9. **Criterio experimental:** qué se monitorea, qué intervalos y exactitud necesita, qué rangos de alerta están aprobados y qué función tienen los motores.

### Para definir la futura unión

10. Repositorio digital y commit/rama que funcionan; modelos y protocolos de sus sensores.
11. Qué significa «un solo proyecto»: ¿un repositorio común, un dashboard común, una única base, un gateway común o también un solo ESP32?
12. Qué debe demostrarse y entregarse: hardware funcionando, comparación analógico/digital, informe de calibración, alertas, control o solo adquisición integrada.

Mensaje que puedes adaptar:

> Profe, revisé el repositorio y el flujo actual es ESP32 con lectura analógica de temperatura/pH, micro-ROS por WiFi, gateway con ROS 2 Jazzy y almacenamiento MongoDB. Para reproducirlo desde mi Mac, ¿me puede facilitar el esquema y el hardware usado, acceso al gateway Ubuntu que funciona, una base de datos de desarrollo y las versiones/configuración de compilación? También necesito confirmar qué panel está vigente y si la integración con el repositorio digital debe compartir infraestructura manteniendo placas separadas o si requiere un único firmware/ESP32. Así puedo reproducir primero una lectura completa y después comparar ambos contratos de datos.

## 12. Cómo pensar la integración con el proyecto digital

La decisión depende del otro repositorio. **La hipótesis inicial más sencilla es conservar cada adquisición que funcione y compartir recepción, esquema de datos y visualización.** Eso puede constituir un solo proyecto aunque existan varias placas y varios programas.

```text
Adquisición analógica ──┐
                       ├─ Gateway / adaptación ── Esquema común ── BD / panel
Adquisición digital ────┘
```

Si ambos usan ROS 2 compatible, puede bastar con recibir sus topics y adaptar formatos. Si el otro usa serial, MQTT o una API, primero hay que decidir dónde convertir esos mensajes. Si el profesor pide una sola placa, habrá que revisar pines, buses, alimentación, memoria, tiempos y compatibilidad de bibliotecas antes de unir firmware.

Compara estas dimensiones cuando llegue el otro repo:

| Pregunta | Lo que este repo hace hoy |
|---|---|
| ¿Qué mide? | Temperatura y pH en el firmware activo. |
| ¿Cómo adquiere? | ADC1, GPIO39/GPIO36. |
| ¿Dónde convierte/calibra? | Firmware y offsets adicionales al guardar. |
| ¿Cómo transporta? | micro-ROS sobre WiFi/UDP. |
| ¿Qué ROS usa? | Referencia Jazzy. |
| ¿Qué mensaje y orden? | `/sensor_data`, Float32MultiArray de cinco elementos. |
| ¿Cómo identifica? | MAC partida en dos números. |
| ¿Qué fecha usa? | La del guardado en gateway. |
| ¿Qué significa un fallo? | Sin estado explícito; algunos fallos devuelven valores normales. |
| ¿Qué almacena? | `datos.temperatura`, `datos.ph`, fecha y dispositivo. |
| ¿Qué asume el panel? | Que cada fila tenga las dos variables. |
| ¿Cómo controla actuadores? | Topic común String y selección local de motor. |

Un contrato común debería aclarar identidad de dispositivo y sensor, variable, unidad, origen analógico/digital, fecha de adquisición/recepción, validez y calibración. No hace falta implementar todo antes de recibir el otro repositorio, pero sí resolver estas ambigüedades antes de mezclar datos.

Aunque hay dependencias y ejemplos DS18B20, **eso no significa que la adquisición digital ya esté integrada**: esos ejemplos no se compilan en el programa actual. Son antecedentes que podrían ayudar cuando se conozca el segundo proyecto.

## 13. Alcance y límites de esta revisión

Se inventariaron **256 archivos versionados**, de los que **122** pertenecen al componente micro-ROS incluido. Se revisaron el flujo activo de firmware, sus interfaces, puente y servicios de BD, scripts de instalación/operación, alertas/reportes, estructura del dashboard, documentación y antecedentes históricos. Los ejemplos de terceros y recursos multimedia se trataron como dependencias/referencias, no como aplicaciones verificadas una por una.

Comprobaciones realizadas sin hardware, credenciales ni instalación adicional:

- Análisis sintáctico de 43 archivos con extensión `.py`: 40 parsean como Python; los tres restantes son CSS guardado con extensión `.py` y cargado como texto.
- `bash -n` sobre diez scripts/hook shell: sin errores de sintaxis. Eso no comprueba compatibilidad con macOS ni dependencias de ejecución.
- Lectura de los seis JSONL históricos y recuento de líneas válidas/inválidas.
- Ejecución aislada de los métodos reales de parseo/guardado del puente con reloj y BD simulados: identidad MAC correcta, repetición del último dato y descarte tras diez segundos.
- Ejecución aislada del adaptador de umbrales: confirmada la incompatibilidad entre `temp_max` y `temperature`.
- Resolución de la ruta del `.env` del dashboard y contraste entre llamada cron y argumento `--daily`.

**No se compiló ni flasheó el ESP32, no se ejecutó ROS real, no se conectó MongoDB ni se inició el dashboard o Telegram.** Tampoco se probó una integración con el repositorio digital. Los procedimientos anteriores son una ruta para validarlo, no una afirmación de que ya funciona de extremo a extremo.

La única incorporación de esta revisión es esta guía; se conserva el código de funcionamiento para poder estudiar y reproducir su comportamiento antes de corregirlo.
