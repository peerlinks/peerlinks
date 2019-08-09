import UIKit
import Sodium

class ChannelController : UIViewController, UITableViewDataSource, UITableViewDelegate, ChannelDelegate {
    @IBOutlet weak var navItem: UINavigationItem!
    @IBOutlet weak var messagesView: UITableView!
    @IBOutlet weak var messageText: UITextField!
    
    var app: AppDelegate!
    var channel: Channel!
    var keyboardWillShow: NSObjectProtocol!
    var keyboardWillHide: NSObjectProtocol!
    
    static let AUTHOR_LENGTH = 6
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        navItem.title = channel.name
        
        app = (UIApplication.shared.delegate as! AppDelegate)
        app.channelDelegate = self
        
        messagesView.dataSource = self
        messagesView.delegate = self
        
        scrollToBottom(animated: false)
        
        // View resize on keyboard open/close
        
        let center = NotificationCenter.default
        
        keyboardWillShow = center.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: nil) {
            (notification) in
            guard let frameEnd = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else {
                return
            }
            self.additionalSafeAreaInsets.bottom = frameEnd.height
        }
        keyboardWillHide = center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: nil) {
            (notification) in
            self.additionalSafeAreaInsets.bottom = 0.0
        }
    }
    
    deinit {
        let center = NotificationCenter.default

        center.removeObserver(keyboardWillShow as Any)
        center.removeObserver(keyboardWillHide as Any)
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
        
        // TODO(indutny): UX
        if text.count > ChannelMessage.MAX_TEXT_LENGTH {
            return
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
        return max(0, channel.messageCount - 1)
    }
    
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "messageCell")!
        
        // NOTE: Skip root
        cell.textLabel?.text = messageText(atOffset: indexPath.row + 1)
        
        return cell
    }
    
    // MARK: ChannelDelegate
    
    func channel(_ channel: Channel, postedMessage message: ChannelMessage) {
        if channel.channelID == self.channel.channelID {
            messagesView.reloadData()
            
            scrollToBottom(animated: true)
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
