require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'BotkinsWatch'
  s.version        = package['version']
  s.summary        = 'WatchConnectivity and companion voice bridge.'
  s.description    = 'Bounded Watch state, controls and PCM for Botkins live voice.'
  s.license        = package['license']
  s.author         = 'Botkins'
  s.homepage       = 'https://botkins.app'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'JitsiWebRTC', '~> 155.0.0'
  s.frameworks = 'AVFoundation', 'WatchConnectivity', 'Foundation'

  s.source_files = "**/*.{h,m,mm,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
