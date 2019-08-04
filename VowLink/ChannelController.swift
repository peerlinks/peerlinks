//
//  ChannelController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/3/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit
import Sodium

class ChannelController : UIViewController, UITableViewDataSource, UITableViewDelegate, ChannelDelegate {
    @IBOutlet weak var navItem: UINavigationItem!
    @IBOutlet weak var messagesView: UITableView!
    @IBOutlet weak var messageText: UITextField!
    
    var app: AppDelegate!
    var channel: Channel!
    
    static let AUTHOR_LENGTH = 6
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        navItem.title = channel.name
        
        app = (UIApplication.shared.delegate as! AppDelegate)
        app.channelDelegate = self
        
        messagesView.dataSource = self
        messagesView.delegate = self
        
        scrollToBottom(animated: false)
    }
    
    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        if let inviteController = segue.destination as? InviteController {
            inviteController.channel = channel
        }
    }
    
    @IBAction func sendClicked(_ sender: Any) {
        // TODO(indutny): trim?
        guard let text = messageText.text else {
            return
        }
        
        let body = Proto_ChannelMessage.Body.with { (body) in
            body.text.text = text
        }
        
        do {
            let _ = try channel.post(message: body, by: app.identity!)
        } catch {
            debugPrint("[channel-controller] failed to post message due to error \(error)")
            return
        }
        
        messageText.text = ""
    }
    
    func scrollToBottom(animated: Bool) {
        let rows = messagesView.dataSource?.tableView(messagesView, numberOfRowsInSection: 0) ?? 0
        if rows == 0 {
            return
        }
        let index = IndexPath(row: rows - 1, section: 0)
        messagesView.scrollToRow(at: index, at: .bottom, animated: animated)
    }
    
    // MARK: UITableViewDataSource
    
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        return channel.messages.count
    }
    
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "messageCell")!
        let message = channel.messages[indexPath.row]
        
        guard case .decrypted(let content) = message.content else {
            cell.textLabel?.text = "<encrypted>"
            return cell
        }
        
        let leafKey = content.chain.leafKey(withChannel: channel)
        let sodium = app.context.sodium
        let fullAuthor = sodium.utils.bin2hex(leafKey)!
        let author = fullAuthor.prefix(ChannelController.AUTHOR_LENGTH)
        
        var text = ""
        switch content.body.body {
        case .some(.root(_)):
            text = "(root)"
            break
        case .some(.text(let body)):
            text = body.text
            break
        default:
            text = "<unknown>"
            break
        }
        
        cell.textLabel?.text = author + ": " + text
        
        return cell
    }
    
    // MARK: ChannelDelegate
    
    func channel(_ channel: Channel, postedMessage message: ChannelMessage) {
        if channel.channelID == self.channel.channelID {
            messagesView.reloadData()

            scrollToBottom(animated: true)
        }
    }
}
