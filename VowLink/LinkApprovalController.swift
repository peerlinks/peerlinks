//
//  LinkApprovalController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/31/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit
import AVFoundation
import Sodium

class LinkApprovalController : UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var context: Context!
    var captureSession: AVCaptureSession!
    var previewLayer: AVCaptureVideoPreviewLayer!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        let app = UIApplication.shared.delegate as! AppDelegate
        context = app.context

        captureSession = AVCaptureSession()
        
        // TODO(indutny): handle errors
        
        guard let device = AVCaptureDevice.default(for: .video) else {
            debugPrint("no capture device")
            return
        }
        guard let input = try? AVCaptureDeviceInput(device: device) else {
            debugPrint("no capture device input")
            return
        }
        
        let output = AVCaptureMetadataOutput()
        
        if !captureSession.canAddInput(input) {
            debugPrint("can't add capture input")
            return
        }
        
        if !captureSession.canAddOutput(output) {
            debugPrint("can't add capture output")
            return
        }
        captureSession.addInput(input)
        captureSession.addOutput(output)
        
        output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
        output.metadataObjectTypes = [.qr]
        
        previewLayer = AVCaptureVideoPreviewLayer(session: captureSession)
        previewLayer.frame = view.layer.bounds
        previewLayer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(previewLayer)
        
        captureSession.startRunning()
    }
    
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        
        if captureSession?.isRunning == false {
            captureSession.startRunning()
        }
    }
    
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        
        if captureSession?.isRunning == true {
            captureSession.stopRunning()
        }
    }
    
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        if metadataObjects.count != 1 {
            return
        }
        
        guard let qr = metadataObjects[0] as? AVMetadataMachineReadableCodeObject else {
            return
        }
        
        guard let value = qr.stringValue else {
            return
        }

        if !value.starts(with: "vow-link://link-request/") {
            return
        }
        
        let index = value.index(value.startIndex, offsetBy: "vow-link://link-request/".count)
        let b64 = String(value[index...])
        
        guard let binary = context.sodium.utils.base642bin(b64) else {
            debugPrint("invalid base64 in scanned link request")
            return
        }
        
        guard let request = try? Proto_LinkRequest(serializedData: Data(binary)) else {
            debugPrint("invalid binary in scanned link request")
            return
        }
        
        print(request)
        AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
    }
}
