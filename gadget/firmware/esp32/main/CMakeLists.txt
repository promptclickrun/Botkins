# What every ESP32 board shares: random numbers, NVS storage, Wi-Fi, the USB console, threads, the WebSocket.
idf_component_register(
  SRCS "main.cpp" "nvs_storage.cpp" "wifi.cpp" "console.cpp" "websocket.cpp"
  INCLUDE_DIRS "."
  REQUIRES botkins_core gadget_port nvs_flash esp_wifi esp_netif esp_event esp_timer pthread esp_app_format esp_hw_support vfs heap esp_driver_usb_serial_jtag esp_hal_usb esp-tls mbedtls tcp_transport espressif__esp_websocket_client)
target_compile_options(${COMPONENT_LIB} PRIVATE $<$<COMPILE_LANGUAGE:CXX>:-std=gnu++17>)
