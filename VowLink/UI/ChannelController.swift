import UIKit
import Sodium

class ChannelController : UIViewController, UITableViewDataSource, UITableViewDelegate, ChannelDelegate {
    @IBOutlet weak var navItem: UINavigationItem!
    @IBOutlet weak var messagesView: UITableView!
    @IBOutlet weak var messageText: UITextField!
    @IBOutlet weak var inviteButton: UIBarButtonItem!
    
    var app: AppDelegate!
    var channel: Channel!
    var keyboardWillShow: NSObjectProtocol!
    var keyboardDidShow: NSObjectProtocol!
    var keyboardWillHide: NSObjectProtocol!
    var sendButton: UIButton!
    
    static let AUTHOR_LENGTH = 6
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        navItem.title = channel.name
        
        app = (UIApplication.shared.delegate as! AppDelegate)
        app.network.channelDelegate = self
        
        messagesView.dataSource = self
        messagesView.delegate = self
        
        scrollToBottom(animated: false)
        
        // Nice send button
        sendButton = UIButton(type: .custom)
        sendButton.setImage(UIImage(named: "Send"), for: .normal)
        sendButton.frame = CGRect(x: 0.0, y: 0.0, width: 25.0 + 4.0, height: 25.0)
        sendButton.addTarget(self, action: #selector(self.sendClicked), for: .primaryActionTriggered)
        sendButton.imageEdgeInsets.right = 4.0
        
        messageText.rightViewMode = .always
        messageText.rightView = sendButton
        
        inviteButton.isEnabled = app.identity?.canInvite(toChannel: channel) ?? false
        
        // Set proper alpha
        messageTextChanged(self)
        
        // View resize on keyboard open/close
        
        let center = NotificationCenter.default
        let originalBottomInset = additionalSafeAreaInsets.bottom
        
        keyboardWillShow = center.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: nil) {
            (notification) in
            guard let frameEnd = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else {
                return
            }
            self.additionalSafeAreaInsets.bottom = frameEnd.height
        }
        keyboardDidShow = center.addObserver(forName: UIResponder.keyboardDidShowNotification, object: nil, queue: nil) {
            (_) in
            self.scrollToBottom(animated: true)
        }
        keyboardWillHide = center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: nil) {
            (_) in
            self.additionalSafeAreaInsets.bottom = originalBottomInset
        }
    }
    
    deinit {
        let center = NotificationCenter.default

        center.removeObserver(keyboardWillShow as Any)
        center.removeObserver(keyboardDidShow as Any)
        center.removeObserver(keyboardWillHide as Any)
    }
    
    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        if let inviteController = segue.destination as? InviteController {
            inviteController.channel = channel
        }
    }
    
    @IBAction func messageTextChanged(_ sender: Any) {
        let count = messageText.text?.count ?? 0
        let isVisible = count != 0 && count < ChannelMessage.MAX_TEXT_LENGTH

        UIView.animate(withDuration: 0.1) {
            self.sendButton.alpha = isVisible ? 1.0 : 0.0
        }
        sendButton.isEnabled = isVisible
    }
    
    @IBAction func sendClicked(_ sender: Any) {
        // TODO(indutny): trim?
        guard let text = messageText.text, !text.isEmpty else {
            return
        }
        
        if text.count == 0 || text.count > ChannelMessage.MAX_TEXT_LENGTH {
            // The button is disabled anyway, what do they think should happen?
            return
        }
        
        do {
            let _ = try app.network.queue.sync {
                try channel.post(message: Channel.text(text), by: app.identity!)
            }
        } catch {
            debugPrint("[channel-controller] failed to post message due to error \(error)")
            return
        }
        
        messageText.text = ""
        messageTextChanged(self)
    }
    
    func scrollToBottom(animated: Bool) {
        let rows = messagesView.numberOfRows(inSection: 0)
        if rows == 0 {
            return
        }
        let index = IndexPath(row: rows - 1, section: 0)
        
        messagesView.scrollToRow(at: index, at: .bottom, animated: animated)
    }
    
    // MARK: UITableViewDataSource
    
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        return app.network.queue.sync {
            return max(0, channel.messageCount - 1)
        }
    }
    
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "messageCell")!
        
        // NOTE: Skip root
        app.network.queue.sync {
            cell.textLabel?.text = messageText(atOffset: indexPath.row + 1)
        }
        
        return cell
    }
    
    // MARK: ChannelDelegate
    
    func channel(_ channel: Channel, postedMessage message: ChannelMessage) {
        if channel.channelID != self.channel.channelID {
            return
        }
        DispatchQueue.main.async {
            self.messagesView.reloadData()
            self.scrollToBottom(animated: true)
        }
    }
    
    // MARK: Utils
    
    func messageText(atOffset offset: Int) -> String {
        var maybeDecrypted: ChannelMessage?
        do {
            maybeDecrypted = try channel.message(atOffset: offset)
        } catch {
            return "<error: \(error)>"
        }
        
        guard let decrypted = maybeDecrypted else {
            return "<not found: \(offset)>"
        }
        
        let content = decrypted.decryptedContent!
        
        let leafKey = content.chain.leafKey(withChannel: channel)
        let sodium = app.context.sodium
        let fullAuthor = sodium.utils.bin2hex(leafKey)!
        let author = fullAuthor.prefix(ChannelController.AUTHOR_LENGTH)
        
        switch content.body.body {
        case .some(.root(_)):
            return "(root)"
        case .some(.text(let body)):
            return "\(author): \(body.text)"
        case .none:
            return "\(author): (none)"
        }
    }
}
