# The shared gadget core (gadget/firmware/core), unchanged, as an ESP-IDF component: the gadget,
# and the screen it draws (draw.cpp, faces.cpp, home.cpp with NanoSVG and stb_truetype), with the
# two fonts embedded as files.
set(core "${CMAKE_CURRENT_LIST_DIR}/../../../core")
idf_component_register(
  SRCS "${core}/src/crypto.cpp" "${core}/src/json.cpp" "${core}/src/link.cpp" "${core}/src/relay.cpp" "${core}/src/gadget.cpp" "${core}/src/sockets.cpp"
       "${core}/src/draw.cpp" "${core}/src/faces.cpp" "${core}/src/home.cpp"
       "${core}/third_party/monocypher/monocypher.c"
  INCLUDE_DIRS "${core}/include"
  PRIV_INCLUDE_DIRS "${core}/third_party/monocypher" "${core}/third_party/nanosvg" "${core}/third_party/stb"
  # A port hands these to Canvas::set_fonts: _binary_DejaVuSerif_Bold_ttf_start/_end and
  # _binary_OpenSans_Regular_ttf_start/_end.
  EMBED_FILES "${core}/fonts/DejaVuSerif-Bold.ttf" "${core}/fonts/OpenSans-Regular.ttf"
  REQUIRES pthread lwip)
target_compile_options(${COMPONENT_LIB} PRIVATE $<$<COMPILE_LANGUAGE:CXX>:-std=gnu++17>)
# Monocypher is C99.
set_source_files_properties("${core}/third_party/monocypher/monocypher.c" PROPERTIES COMPILE_OPTIONS "-std=c99")
# The drawing runs on every change of the screen: built for speed, not size, like the host build.
set_source_files_properties("${core}/src/draw.cpp" "${core}/src/faces.cpp" "${core}/src/home.cpp" PROPERTIES COMPILE_OPTIONS "-O2")
