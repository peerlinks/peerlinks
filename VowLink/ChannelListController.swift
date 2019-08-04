//
//  ChannelListController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/3/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit

class ChannelListController : UIViewController, UIPickerViewDataSource, UIPickerViewDelegate {
    @IBOutlet weak var channelPicker: UIPickerView!
    @IBOutlet weak var selectButton: UIButton!
    var app: AppDelegate!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        app = (UIApplication.shared.delegate as! AppDelegate)
        
        channelPicker.delegate = self
        channelPicker.dataSource = self
        
        selectButton.isEnabled = !app.channelList.channels.isEmpty
    }
    
    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        if let channelController = segue.destination as? ChannelController {
            let row = channelPicker.selectedRow(inComponent: 0)
            channelController.channel = app.channelList.channels[row]
        }
    }
    
    func numberOfComponents(in pickerView: UIPickerView) -> Int {
        return 1
    }
    
    func pickerView(_ pickerView: UIPickerView, numberOfRowsInComponent component: Int) -> Int {
        return app.channelList.channels.count
    }
    
    func pickerView(_ pickerView: UIPickerView, titleForRow row: Int, forComponent component: Int) -> String? {
        return app.channelList.channels[row].name
    }
    
    func reloadChannels() {
        channelPicker.reloadAllComponents()
    }
}
