//
//  IdentityController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/30/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit

class IdentityController : UIViewController, UIPickerViewDelegate, UIPickerViewDataSource, IdentityManagerDelegate {
    @IBOutlet weak var identityPicker: UIPickerView!
    var identityManager: IdentityManager!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        identityPicker.delegate = self
        identityPicker.dataSource = self
        
        let app = (UIApplication.shared.delegate as! AppDelegate)
        identityManager = app.identityManager
        
        // TODO(indutny): this has bad code smell
        identityManager.delegate = self
    }
    
    deinit {
        identityManager.delegate = nil
    }
    
    func numberOfComponents(in pickerView: UIPickerView) -> Int {
        return 1
    }
    
    func pickerView(_ pickerView: UIPickerView, numberOfRowsInComponent component: Int) -> Int {
        return identityManager.identities.count
    }
    
    func pickerView(_ pickerView: UIPickerView, titleForRow row: Int, forComponent component: Int) -> String? {
        return identityManager.identities[row]
    }
    
    // MARK: - Identity Manager

    func identityManager(_ manager: IdentityManager, createdIdentity identity: Identity) {
        identityPicker.reloadAllComponents()
    }
}
