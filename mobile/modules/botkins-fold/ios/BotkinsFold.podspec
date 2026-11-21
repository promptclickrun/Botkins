require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'BotkinsFold'
  s.version        = package['version']
  s.summary        = 'The pose of a folding iPhone: its hinge, the fold, and which edge holds the vertical bar.'
  s.description    = 'The pose of a folding iPhone: its hinge, the fold, and which edge holds the vertical bar.'
  s.license        = package['license']
  s.author         = 'Botkins'
  s.homepage       = 'https://botkins.app'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
