# The shared gadget core (gadget/firmware/core), unchanged, as an ESP-IDF component.
set(core "${CMAKE_CURRENT_LIST_DIR}/../../../core")
idf_component_register(
  SRCS "${core}/src/crypto.cpp" "${core}/src/json.cpp" "${core}/src/link.cpp" "${core}/src/gadget.cpp" "${core}/src/sockets.cpp"
       "${core}/third_party/monocypher/monocypher.c"
  INCLUDE_DIRS "${core}/include"
  PRIV_INCLUDE_DIRS "${core}/third_party/monocypher"
  REQUIRES pthread lwip)
target_compile_options(${COMPONENT_LIB} PRIVATE $<$<COMPILE_LANGUAGE:CXX>:-std=gnu++17>)
# Monocypher is C99.
set_source_files_properties("${core}/third_party/monocypher/monocypher.c" PROPERTIES COMPILE_OPTIONS "-std=c99")
