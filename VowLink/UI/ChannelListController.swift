import UIKit

class ChannelListController : UIViewController, UITableViewDataSource {
    var app: AppDelegate!
    @IBOutlet weak var tableView: UITableView!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        app = (UIApplication.shared.delegate as! AppDelegate)
        
        tableView.dataSource = self
    }
    
    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        if let cell = sender as? UITableViewCell,
            let channelController = segue.destination as? ChannelController {
            let index = tableView.indexPath(for: cell)!
            channelController.channel = app.channelList.channels[index.row]
        }
    }
    
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
         return app.channelList.channels.count
    }
    
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let name = app.channelList.channels[indexPath.row].name
        let cell = tableView.dequeueReusableCell(withIdentifier: "channelCell")!
        cell.textLabel?.text = name
        return cell
    }

    func reloadChannels() {
        tableView.reloadData()
    }
}
