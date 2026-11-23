# The M5Stack StopWatch: power chips, display, touch, codec, keys and the screen (drawn by the core).
idf_component_register(
  SRCS "board.cpp" "stopwatch_power.cpp" "display.cpp" "touch.cpp" "audio.cpp" "screen.cpp"
  REQUIRES gadget_port botkins_core esp_driver_i2c esp_driver_i2s esp_driver_gpio esp_driver_spi esp_lcd esp_timer heap
  WHOLE_ARCHIVE)
target_compile_options(${COMPONENT_LIB} PRIVATE $<$<COMPILE_LANGUAGE:CXX>:-std=gnu++17>)
