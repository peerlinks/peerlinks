//
//  IdentityController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/30/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit

class IdentityController : UIViewController, UIPickerViewDelegate, UIPickerViewDataSource {
    @IBOutlet weak var identityPicker: UIPickerView!
    var context: Context!
    var identities = [Identity]()
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        let app = (UIApplication.shared.delegate as! AppDelegate)
        context = app.context
        
        let keys = context.keychain.allKeys().filter { (key) -> Bool in
            return key.starts(with: "identity/")
        }
        
        for key in keys {
            let index = key.index(key.startIndex, offsetBy: 9)
            do {
                identities.append(try Identity(context: context, name: String(key[index...])))
            } catch {
                debugPrint("failed to fetch identity due to error \(error)")
            }
        }
        
        identityPicker.delegate = self
        identityPicker.dataSource = self
    }
    
    func numberOfComponents(in pickerView: UIPickerView) -> Int {
        return 1
    }
    
    func pickerView(_ pickerView: UIPickerView, numberOfRowsInComponent component: Int) -> Int {
        return identities.count
    }
    
    func pickerView(_ pickerView: UIPickerView, titleForRow row: Int, forComponent component: Int) -> String? {
        return identities[row].name
    }
    
    // MARK: - Identity Manager
    
    func createIdentity(name: String) throws {
        // TODO(indutny): avoid duplicates by throwing
        let id = try Identity(context: context, name: name)
        identities.append(id)
        identityPicker.reloadAllComponents()
    }
}
