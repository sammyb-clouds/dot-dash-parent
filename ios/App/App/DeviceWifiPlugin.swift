import Foundation
import Capacitor
import NetworkExtension

// Joins and leaves a Dot Dash's setup network from inside the app.
//
// This is what lets Wi-Fi setup happen without the parent going to iOS
// Settings: the app asks iOS to join "Dot Dash Setup", talks to the device's
// portal at 192.168.4.1 over native HTTP, then lets the phone fall back to its
// home network. A web page cannot do either half -- no browser can join a
// network, and an https page may not call a plain-http address -- which is why
// this flow exists only in the native app.
//
// Requires the Hotspot Configuration capability, plus NSAllowsLocalNetworking
// and NSLocalNetworkUsageDescription in Info.plist.
@objc(DeviceWifiPlugin)
public class DeviceWifiPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeviceWifiPlugin"
    public let jsName = "DeviceWifi"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "join", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "leave", returnType: CAPPluginReturnPromise)
    ]

    @objc func join(_ call: CAPPluginCall) {
        guard let ssid = call.getString("ssid"), !ssid.isEmpty else {
            call.reject("An SSID is required.", "BAD_ARGS")
            return
        }
        let config = NEHotspotConfiguration(ssid: ssid)
        // joinOnce: iOS forgets the network when the app leaves the
        // foreground, so a phone never keeps hopping back onto a device's
        // internet-less setup network after setup is over.
        config.joinOnce = true

        NEHotspotConfigurationManager.shared.apply(config) { error in
            guard let error = error as NSError? else {
                call.resolve(["joined": true])
                return
            }
            if error.domain == NEHotspotConfigurationErrorDomain {
                switch error.code {
                case NEHotspotConfigurationError.alreadyAssociated.rawValue:
                    call.resolve(["joined": true])
                    return
                case NEHotspotConfigurationError.userDenied.rawValue:
                    call.reject("Joining the network was declined.", "USER_DENIED")
                    return
                default:
                    break
                }
            }
            call.reject(error.localizedDescription, "JOIN_FAILED")
        }
    }

    @objc func leave(_ call: CAPPluginCall) {
        if let ssid = call.getString("ssid"), !ssid.isEmpty {
            NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid)
        }
        call.resolve()
    }
}

// Registers the app's own native plugins. Capacitor discovers npm plugins by
// itself; one that lives inside the app target has to be handed to the bridge.
// Main.storyboard points at this class instead of CAPBridgeViewController.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(DeviceWifiPlugin())
    }
}
