import UIKit

class NewIdentityController : UITableViewController {
    @IBOutlet weak var nameField: UITextField!
    @IBOutlet weak var saveButton: UIBarButtonItem!
    var identityController: IdentityController!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        saveButton.isEnabled = false
        
        let parent = navigationController?.viewControllers.first
        identityController = parent as? IdentityController
    }
    
    @IBAction func onNameFieldChange(_ sender: Any) {
        saveButton.isEnabled = identityController.isAllowed(name: nameField.text ?? "")
    }
    
    @IBAction func saveClicked(_ sender: Any) {
        let name = nameField.text ?? ""
        
        do {
            try identityController?.createIdentity(name: name)
        } catch {
            debugPrint("failed to create identity \(error)")
            return
        }
        
        navigationController?.popViewController(animated: true)
    }
}
