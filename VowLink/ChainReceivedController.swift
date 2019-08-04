//
//  ChainLinkController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/1/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit

enum ChainReceivedError : Error {
    case invalidInvite
}

class ChainReceivedController : ViewController {
    @IBOutlet weak var saveButton: UIBarButtonItem!
    @IBOutlet weak var descriptionField: UITextField!
    
    var chain: Chain!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        descriptionField.text = chain.channelName
        descriptionChanged(self)
    }
    
    @IBAction func descriptionChanged(_ sender: Any) {
        saveButton.isEnabled = !(descriptionField.text?.isEmpty ?? false)
    }
    
    @IBAction func saveClicked(_ sender: Any) {
        if !saveButton.isEnabled {
            return
        }
        
        let app = (UIApplication.shared.delegate as! AppDelegate)
        do {
            guard let publicKey = chain.channelPubKey else {
                throw ChainReceivedError.invalidInvite
            }
            
            guard let root = chain.channelRoot else {
                throw ChainReceivedError.invalidInvite
            }
            
            let name = descriptionField.text!
            
            let channel = try Channel(context: app.context,
                                      publicKey: publicKey,
                                      name: name,
                                      root: root,
                                      chain: chain)
            try app.channelList.add(channel)
        } catch {
            // TODO(indutny): display
            debugPrint("failed to save & subscribe to channel \(error)")
        }
        
        for viewController in navigationController!.viewControllers.reversed() {
            if let channelList = viewController as? ChannelListController {
                channelList.reloadChannels()
                navigationController?.popToViewController(channelList, animated: true)
                break
            }
        }
    }
}
