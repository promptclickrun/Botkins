# The M5Stack StopWatch: power chips, display, codec, keys and the screen drawing.
idf_component_register(
  SRCS "board.cpp" "stopwatch_power.cpp" "display.cpp" "audio.cpp" "screen.cpp" "font5x7.cpp"
  REQUIRES gadget_port botkins_core esp_driver_i2c esp_driver_i2s esp_driver_gpio esp_driver_spi esp_lcd esp_timer heap
  WHOLE_ARCHIVE)
target_compile_options(${COMPONENT_LIB} PRIVATE $<$<COMPILE_LANGUAGE:CXX>:-std=gnu++17>)
