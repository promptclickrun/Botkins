require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'BotkinsActivity'
  s.version        = package['version']
  s.summary        = 'Live Activities and the key for sealed notifications.'
  s.description    = 'Live Activities and the key for sealed notifications.'
  s.license        = package['license']
  s.author         = 'Botkins'
  s.homepage       = 'https://botkins.app'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Its notification hook: a notification's answering actions are caught as the app launches.
  s.dependency 'ExpoNotifications'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
