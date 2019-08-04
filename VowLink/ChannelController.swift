//
//  ChannelController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/3/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit

class ChannelController : UIViewController {
    @IBOutlet weak var navItem: UINavigationItem!
    @IBOutlet weak var messagesView: UITableView!
    @IBOutlet weak var messageText: UITextField!
    
    var channel: Channel!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        navItem.title = channel.name
    }
    
    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        if let inviteController = segue.destination as? InviteController {
            inviteController.channel = channel
        }
    }
    
    @IBAction func sendClicked(_ sender: Any) {
    }
}
