import UIKit
import AVFoundation
import Sodium

class InviteController : UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var context: Context!
    var channel: Channel!
    var captureSession: AVCaptureSession!
    var previewLayer: AVCaptureVideoPreviewLayer!
    var request: Proto_InviteRequest?
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        let app = UIApplication.shared.delegate as! AppDelegate
        context = app.context
        
        captureSession = AVCaptureSession()
        
        previewLayer = AVCaptureVideoPreviewLayer(session: captureSession)
        previewLayer.frame = view.layer.bounds
        previewLayer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(previewLayer)
        
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
        
        captureSession.startRunning()
    }
    
    override func viewLayoutMarginsDidChange() {
        previewLayer.frame = view.layer.bounds
    }
    
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        
        if captureSession.isRunning == false && !captureSession.inputs.isEmpty {
            captureSession.startRunning()
        }
    }
    
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        
        if captureSession.isRunning == true && !captureSession.inputs.isEmpty {
            captureSession.stopRunning()
        }
    }
    
    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        if let confirm = segue.destination as? InviteConfirmController {
            confirm.request = request
            confirm.channel = channel
        }
        
        super.prepare(for: segue, sender: sender)
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
        
        if !value.starts(with: "vow-link://invite-request/") {
            return
        }
        
        let index = value.index(value.startIndex, offsetBy: "vow-link://invite-request/".count)
        let b64 = String(value[index...])
        
        guard let binary = context.sodium.utils.base642bin(b64) else {
            debugPrint("invalid base64 in scanned invite request")
            return
        }
        
        guard let request = try? Proto_InviteRequest(serializedData: Data(binary)) else {
            debugPrint("invalid binary in scanned invite request")
            return
        }
        
        do {
            try request.validate(context: context)
        } catch {
            debugPrint("invalid invite request due to error \(error)")
            return
        }
        
        self.request = request
        AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        
        captureSession.stopRunning()
        performSegue(withIdentifier: "confirmLinkApproval", sender: self)
    }
}
