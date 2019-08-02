//
//  LinkConfirmalController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/31/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit
import Sodium

class LinkConfirmalController : UITableViewController {
    var app: AppDelegate!
    var request: Proto_LinkRequest?
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
        defer {
            navigationController?.popViewController(animated: true)
        }
        guard let request = request else {
            return
        }
        guard let id = app.identity else {
            return
        }

        // TODO(indutny): wait for peer to connect, or at least say that it is not connected
        
        do {
            let link = try id.issueLink(for: Bytes(request.trusteePubKey))
            
            let encryptedLink = try link.encrypt(withContext: id.context,
                                                 andPubKey: Bytes(request.boxPubKey))
            
            let packet = Proto_Packet.with { (packet) in
                packet.link = encryptedLink
            }
            
            try app.p2p.send(packet, to: request.peerID)
        } catch {
            fatalError("failed to issue link \(request) due to error \(error)")
        }
    }
}
