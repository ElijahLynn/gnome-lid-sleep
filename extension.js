import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const CONFIG_PATH = '/etc/systemd/logind.conf.d/lid.conf';
const SCRIPT_PATH = '/home/elijah/.config/fish/functions/lid-sleep.fish';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

class LidSleepIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super(0.5, 'Lid sleep');

        this._busy = false;
        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'weather-clear-night-symbolic',
            style_class: 'system-status-icon',
        });
        this._box.add_child(this._icon);
        this.add_child(this._box);

        this._toggle = new PopupMenu.PopupSwitchMenuItem('Sleep when lid closes', false);
        this._toggle.connect('toggled', (_item, state) => this._setState(state));
        this.menu.addMenuItem(this._toggle);

        this._config = Gio.File.new_for_path(CONFIG_PATH);
        try {
            this._monitor = this._config.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => this._sync());
        } catch (error) {
            console.warn(`Lid Sleep Toggle: unable to monitor config: ${error.message}`);
        }

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._sync();
        });
        this._sync();
    }

    _isOn() {
        // The override file exists only when sleep-on-close is disabled.
        return !this._config.query_exists(null);
    }

    _sync() {
        const isOn = this._isOn();
        this._toggle.setToggleState(isOn);
        this._icon.opacity = isOn ? 255 : 128;
    }

    async _setState(enabled) {
        if (this._busy || enabled === this._isOn())
            return;

        this._busy = true;
        this._toggle.setSensitive(false);

        const action = enabled ? 'on' : 'off';
        const fishCommand = `source '${SCRIPT_PATH}'; lid-sleep ${action}`;
        // No pkexec — fish calls sudo internally, and sudoers grants NOPASSWD
        // for the exact commands lid-sleep needs (see /etc/sudoers.d/lid-sleep).
        const process = new Gio.Subprocess({
            argv: ['/usr/bin/fish', '-c', fishCommand],
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });

        try {
            process.init(null);
            const [, stdout, stderr] = await process.communicate_utf8_async(null, null);
            if (!process.get_successful()) {
                const message = stderr.trim() || 'Authentication was cancelled or the command failed.';
                throw new Error(message);
            }
            if (stdout.trim())
                Main.notify('Lid Sleep', stdout.trim());
        } catch (error) {
            console.error(`Lid Sleep Toggle: ${error.message}`);
            Main.notifyError('Lid Sleep could not be changed', error.message);
        } finally {
            this._busy = false;
            this._toggle.setSensitive(true);
            this._sync();
        }
    }

    destroy() {
        this._monitor?.cancel();
        this._monitor = null;
        super.destroy();
    }
}

export default class LidSleepExtension extends Extension {
    enable() {
        this._indicator = new LidSleepIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
