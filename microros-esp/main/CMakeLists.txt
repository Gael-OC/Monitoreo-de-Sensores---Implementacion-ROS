# WiFi and sdkconfig are prepared by the root CMakeLists before ESP-IDF loads Kconfig.

# ============================================================================
# SELECCIÓN DE VERSIÓN
# Comenta la versión que NO quieres usar
# ============================================================================

# OPCIÓN A: Versión WiFi/UDP (modular) - Para Agent UDP
idf_component_register(
    SRCS 
        "versions/wifi/src/main.c"
        "versions/wifi/src/sensor_manager_filtered.c"
        "versions/wifi/src/ros_publisher.c"
        "versions/wifi/src/network_manager.c"
        "versions/wifi/src/motor_controller.c"
    INCLUDE_DIRS 
        "." 
        "versions/wifi"
        "versions/wifi/include"
    REQUIRES 
        micro_ros_espidf_component 
        esp_adc 
        esp_wifi 
        esp_netif 
        nvs_flash
        driver
)

# ============================================================================
# VERIFICACIÓN DE VERSIÓN DEL SENSOR MANAGER
# ============================================================================
message(STATUS "")
message(STATUS "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
message(STATUS "📊 VERSIÓN DE SENSOR MANAGER: FILTRADA (MEDIANA)")
message(STATUS "   Archivo: sensor_manager_filtered.c")
message(STATUS "   Filtro: Mediana de 10 muestras")
message(STATUS "   Beneficios: Elimina outliers y spikes")
message(STATUS "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
message(STATUS "")

# OPCIÓN B: Versión Serial/UART - Para Agent Serial
# Descomenta esta y comenta la OPCIÓN A para usar serial
# idf_component_register(
#     SRCS "versions/sensor_temp_ph/sensor_tempV3.c"
#          "esp32_serial_transport.c"
#     INCLUDE_DIRS "." "versions/sensor_temp_ph"
#     REQUIRES micro_ros_espidf_component esp_adc driver
# )

# UDP es el transporte por defecto, no necesita macro especial