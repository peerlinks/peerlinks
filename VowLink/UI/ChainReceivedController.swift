import UIKit

enum ChainReceivedError : Error {
    case invalidInvite
}

class ChainReceivedController : UIViewController {
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
            try app.network.queue.sync {
                try app.network.confirm(invite: chain, withChannelName: descriptionField.text ?? "", andIdentity: app.identity!)
            }
        } catch {
            let alert = UIAlertController(title: "Subscription failed",
                                          message: "Error: \(error)",
                                          preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Close", style: .cancel, handler: nil))
            present(alert, animated: true)
            return
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
