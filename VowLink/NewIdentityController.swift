import UIKit

class NewIdentityController : UITableViewController {
    @IBOutlet weak var nameField: UITextField!
    @IBOutlet weak var saveButton: UIBarButtonItem!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        saveButton.isEnabled = false
    }
    
    @IBAction func onNameFieldChange(_ sender: Any) {
        saveButton.isEnabled = (nameField.text ?? "").count != 0
    }
    
    @IBAction func saveClicked(_ sender: Any) {
        let name = nameField.text ?? ""
        
        let parent = navigationController?.viewControllers.first
        let identityController = parent as? IdentityController
        
        do {
            try identityController?.createIdentity(name: name)
        } catch {
            debugPrint("failed to create identity \(error)")
            return
        }
        
        navigationController?.popViewController(animated: true)
    }
}
