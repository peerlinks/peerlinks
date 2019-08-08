import UIKit
import Sodium

class InviteConfirmController : UITableViewController {
    var app: AppDelegate!
    var request: Proto_InviteRequest?
    var channel: Channel!
    
    @IBOutlet weak var publicKey: UILabel!
    @IBOutlet weak var peerID: UILabel!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        app = (UIApplication.shared.delegate as! AppDelegate)
        let sodium = app.context.sodium
        
        if let pubKey = request?.trusteePubKey {
            publicKey.text = sodium.utils.bin2hex(Bytes(pubKey))
        } else {
            publicKey.text = "(missing)"
        }
        
        peerID.text = request?.peerID
    }
    
    @IBAction func doneClicked(_ sender: Any) {
        guard let request = request, let id = app.identity else {
            return
        }
        
        let peers = app.p2p.peers(byDisplayName: request.peerID)
        if peers.isEmpty {
            let alert = UIAlertController(title: "Peer offline",
                                          message: "Make sure that invitee device is unlocked and running this application",
                                          preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Close", style: .cancel, handler: nil))
            present(alert, animated: true)
            return
        }
        
        do {
            let link = try id.issueLink(for: Bytes(request.trusteePubKey), andChannel: channel)
            
            guard let chain = try id.chain(for: channel)?.appendedLink(link) else {
                fatalError("no chain available for the channel \(channel!)")
            }
            
            let encryptedInvite = try chain.encrypt(withPublicKey: Bytes(request.boxPubKey), andChannel: channel)
            
            let packet = Proto_Packet.with { (packet) in
                packet.invite = encryptedInvite
            }
            
            try app.p2p.send(packet, to: peers)
        } catch {
            fatalError("failed to issue invite \(request) due to error \(error)")
        }
        
        if let nav = navigationController {
            // Pop to the channel view
            let preLast = nav.viewControllers.first { (viewController) -> Bool in
                return viewController is ChannelController
            }
            if let preLast = preLast {
                nav.popToViewController(preLast, animated: true)
            } else {
                nav.popViewController(animated: true)
            }
        }
    }
}
