//
//  ReceivedLinkController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/1/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit

class LinkReceivedController : ViewController {
    @IBOutlet weak var saveButton: UIBarButtonItem!
    @IBOutlet weak var descriptionField: UITextField!
    
    var link: Link!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        descriptionField.text = link.label
        descriptionChanged(self)
    }
    
    @IBAction func descriptionChanged(_ sender: Any) {
        saveButton.isEnabled = !(descriptionField.text?.isEmpty ?? false)
    }
    
    @IBAction func saveClicked(_ sender: Any) {
        if !saveButton.isEnabled {
            return
        }
        
        link.label = descriptionField.text
        
        let app = (UIApplication.shared.delegate as! AppDelegate)
        do {
            try app.identity?.addLink(link)
            
            if let channelPubKey = link.channelPubKey {
                try app.channelList.add(publicKey: channelPubKey, label: descriptionField.text)
            }
            
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
