/* exported NewTabToolsLinks, GridPrefs, BackgroundImage, TileData, SavedThumbs, ThumbnailPrefs */
var EXPORTED_SYMBOLS = ['NewTabToolsLinks', 'GridPrefs', 'BackgroundImage', 'TileData', 'SavedThumbs', 'ThumbnailPrefs'];
var XHTMLNS = 'http://www.w3.org/1999/xhtml';

/* globals Components, Services, XPCOMUtils, Iterator */
var { classes: Cc, interfaces: Ci, utils: Cu } = Components;

Cu.import('resource://gre/modules/Services.jsm');
Cu.import('resource://gre/modules/XPCOMUtils.jsm');

/* globals BackgroundPageThumbs, FileUtils, NewTabUtils, OS, PageThumbs, PageThumbsStorage */
XPCOMUtils.defineLazyModuleGetter(this, 'BackgroundPageThumbs', 'resource://gre/modules/BackgroundPageThumbs.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'FileUtils', 'resource://gre/modules/FileUtils.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'NewTabUtils', 'resource://gre/modules/NewTabUtils.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'OS', 'resource://gre/modules/osfile.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'PageThumbs', 'resource://gre/modules/PageThumbs.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'PageThumbsStorage', 'resource://gre/modules/PageThumbs.jsm');

/* globals idleService */
XPCOMUtils.defineLazyServiceGetter(this, 'idleService', '@mozilla.org/widget/idleservice;1', 'nsIIdleService');

var NewTabToolsLinks = {
	PREF_HISTORY: 'extensions.newtabtools.historytiles.show',
	PREF_FILTER: 'extensions.newtabtools.filter',
	getLinks: function() {
		if (this._getLinksCache) {
			return this._getLinksCache;
		}

		let finalLinks = Array.slice(NewTabUtils.pinnedLinks.links);
		if (!Services.prefs.getBoolPref(this.PREF_HISTORY)) {
			this._getLinksCache = finalLinks;
			return finalLinks;
		}

		let historyLinks = NewTabUtils.links._getMergedProviderLinks();

		// Filter blocked and pinned links.
		historyLinks = historyLinks.filter(function(link) {
			return link.type == 'history' &&
				!NewTabUtils.blockedLinks.isBlocked(link) &&
				!NewTabUtils.pinnedLinks.isPinned(link);
		});

		if (Services.prefs.prefHasUserValue(this.PREF_FILTER)) {
			let countPref = Services.prefs.getCharPref(this.PREF_FILTER);
			let counts = JSON.parse(countPref);
			historyLinks = historyLinks.filter(function(item) {
				let match = /^https?:\/\/([^\/]+)\//.exec(item.url);
				if (!match)
					return true;
				if (match[1] in counts) {
					if (counts[match[1]]) {
						counts[match[1]]--;
						return true;
					}
					return false;
				}
				return true;
			});
		}

		// Try to fill the gaps between pinned links.
		for (let i = 0; i < finalLinks.length && historyLinks.length; i++)
			if (!finalLinks[i])
				finalLinks[i] = historyLinks.shift();

		// Append the remaining links if any.
		if (historyLinks.length)
			finalLinks = finalLinks.concat(historyLinks);

		this._getLinksCache = finalLinks;
		return finalLinks;
	}
};

var GridPrefs = {
	PREF_ROWS: 'extensions.newtabtools.rows',
	PREF_COLUMNS: 'extensions.newtabtools.columns',

	_gridRows: null,
	get gridRows() {
		if (!this._gridRows) {
			this._gridRows = Math.max(1, Services.prefs.getIntPref(GridPrefs.PREF_ROWS));
		}
		return this._gridRows;
	},
	_gridColumns: null,
	get gridColumns() {
		if (!this._gridColumns) {
			this._gridColumns = Math.max(1, Services.prefs.getIntPref(GridPrefs.PREF_COLUMNS));
		}
		return this._gridColumns;
	},
	init: function GridPrefs_init() {
		Services.prefs.addObserver(GridPrefs.PREF_ROWS, this, true);
		Services.prefs.addObserver(GridPrefs.PREF_COLUMNS, this, true);
	},
	observe: function GridPrefs_observe(subject, topic, data) {
		if (data == GridPrefs.PREF_ROWS) {
			this._gridRows = null;
		} else {
			this._gridColumns = null;
		}
	},
	QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.nsISupportsWeakReference]),
};
GridPrefs.init();

function notifyTileChanged(url, key) {
	let urlString = Cc['@mozilla.org/supports-string;1'].createInstance(Ci.nsISupportsString);
	urlString.data = url;
	Services.obs.notifyObservers(urlString, 'newtabtools-change', key);
}

var TileData = {
	PREF: 'extensions.newtabtools.tiledata',
	_data: new Map(),
	get: function(url, key) {
		if (this._data.has(url)) {
			return this._data.get(url).get(key) || null;
		}
		return null;
	},
	set: function(url, key, value) {
		let urlData = this._data.get(url) || new Map();

		if (value === null) {
			urlData.delete(key);
			if (urlData.size == 0) {
				this._data.delete(url);
			}
		} else {
			urlData.set(key, value);
			if (!this._data.has(url)) {
				this._data.set(url, urlData);
			}
		}

		notifyTileChanged(url, key);
		this._setPref();
	},
	_getPref: function() {
		try {
			let value = Services.prefs.getCharPref(TileData.PREF);
			let json = JSON.parse(value);
			for (let [url, urlData] in Iterator(json)) {
				this._data.set(url, new Map(Iterator(urlData)));
			}
		} catch (e) {
			Cu.reportError(e);
		}
	},
	_setPref: function() {
		let obj = {};
		for (let [url, urlData] of this._data.entries()) {
			obj[url] = {};
			for (let [key, value] of urlData.entries()) {
				obj[url][key] = value;
			}
		}
		Services.prefs.setCharPref(TileData.PREF, JSON.stringify(obj));
	}
};
TileData._getPref();

var SavedThumbs = {
	_ready: false,
	_list: new Set(),
	getThumbnailURL: function(url) {
		return this._readDir().then(() => {
			let leafName = this.getThumbnailLeafName(url);
			if (this.hasSavedThumb(url, leafName)) {
				let path = this.getThumbnailPath(url, leafName);
				return Services.io.newFileURI(new FileUtils.File(path)).spec + '?' + Math.random();
			} else {
				return PageThumbs.getThumbnailURL(url) + '&' + Math.random();
			}
		});
	},
	get thumbnailDirectory() {
		return OS.Path.join(OS.Constants.Path.profileDir, 'newtab-savedthumbs');
	},
	getThumbnailLeafName: function(url) {
		return PageThumbsStorage.getLeafNameForURL(url);
	},
	getThumbnailPath: function(url, leafName=this.getThumbnailLeafName(url)) {
		return OS.Path.join(this.thumbnailDirectory, leafName);
	},
	// These functions assume _readDir has already been called.
	addSavedThumb: function(url, leafName=this.getThumbnailLeafName(url)) {
		this._list.add(leafName);
		notifyTileChanged(url, 'thumbnail');
	},
	hasSavedThumb: function(url, leafName=this.getThumbnailLeafName(url)) {
		return this._list.has(leafName);
	},
	removeSavedThumb: function(url, leafName=this.getThumbnailLeafName(url)) {
		this._list.delete(leafName);
		notifyTileChanged(url, 'thumbnail');
	},
	_readDirPromises: [],
	_readDir: function() {
		return new Promise((resolve) => {
			if (this.ready) {
				resolve();
				return;
			}
			this._readDirPromises.push(resolve);
			if (this._readDirPromises.length == 1) {
				let thumbDir = OS.Path.join(this.thumbnailDirectory);
				let iterator = new OS.File.DirectoryIterator(thumbDir);
				iterator.forEach((entry) => {
					this._list.add(entry.name);
				}).then(() => {
					iterator.close();
					this.ready = true;
					this._readDirPromises.forEach((d) => d.call());
					delete this._readDirPromises;
				});
			}
		});
	},
	forceReloadThumbnail: function(url) {
		return new Promise((resolve, reject) => {
			let path = PageThumbsStorage.getFilePathForURL(url);
			OS.File.remove(path).then(function() {
				BackgroundPageThumbs.capture(url, {
					onDone: function() {
						notifyTileChanged(url, 'thumbnail');
						resolve();
					}
				});
			}, reject);
		});
	}
};

var BackgroundImage = {
	MODE_SINGLE: 0, // old behaviour
	MODE_FOLDER_SHARED: 1, // pick one, use for all (could _change regularly)
	MODE_FOLDER_UNSHARED: 2, // new image each page
	PREF_DIRECTORY: 'extensions.newtabtools.background.directory',
	PREF_INTERVAL: 'extensions.newtabtools.background.changeinterval',
	PREF_MODE: 'extensions.newtabtools.background.mode',
	IDLE_TIME: 3,
	_asleep: false,
	_list: [],
	_state: 'unready',
	_initCallbacks: [],
	_themeCache: new Map(),
	get modeIsSingle() {
		return this.mode != BackgroundImage.MODE_FOLDER_SHARED && this.mode != BackgroundImage.MODE_FOLDER_UNSHARED;
	},
	_readPrefs: function() {
		this.mode = BackgroundImage.MODE_SINGLE;
		this.changeInterval = 0;

		if (Services.prefs.getPrefType(BackgroundImage.PREF_DIRECTORY) == Services.prefs.PREF_STRING) {
			this._directory = Services.prefs.getCharPref(BackgroundImage.PREF_DIRECTORY);
		} else {
			return;
		}
		if (Services.prefs.getPrefType(BackgroundImage.PREF_MODE) == Services.prefs.PREF_INT) {
			this.mode = Services.prefs.getIntPref(BackgroundImage.PREF_MODE);
		}
		if (Services.prefs.getPrefType(BackgroundImage.PREF_INTERVAL) == Services.prefs.PREF_INT) {
			this.changeInterval = Services.prefs.getIntPref(BackgroundImage.PREF_INTERVAL);
		}
	},
	_init: function() {
		if (this.modeIsSingle) {
			return;
		}

		let promise = new Promise(resolve => {
			if (this._state == 'ready') {
				resolve();
			} else {
				this._initCallbacks.push(resolve);
			}
		});

		if (this._state == 'unready') {
			this._state = 'loading';

			this._list = [];
			this._entriesForDir(this._directory).then(() => {
				this._state = 'ready';
				this._list.sort();
				if (this.mode == BackgroundImage.MODE_FOLDER_SHARED) {
					return this._change();
				}
			}).then(() => {
				this._initCallbacks.forEach(cb => cb.call());
				this._initCallbacks = [];
			});
		}

		return promise;
	},
	_entriesForDir: function(path) {
		let di = new OS.File.DirectoryIterator(path);
		let dirs = [];
		return di.forEach(e => {
			if (!e.isSymLink) {
				if (e.isDir)
					dirs.push(e.path);
				else if (/\.(jpe?g|png)/i.test(e.name))
					this._list.push(e.path);
			}
		}).then(() => {
			di.close();
			let dirPromises = dirs.map(d => this._entriesForDir(d));
			return Promise.all(dirPromises);
		});
	},
	_pick: function() {
		if (this._state == 'ready' && this._list.length == 0) {
			return new Promise(function(resolve) {
				resolve(null, null);
			});
		}

		return this._init().then(() => {
			let index = Math.floor(Math.random() * this._list.length);
			let url = Services.io.newFileURI(new FileUtils.File(this._list[index])).spec;
			if (this._themeCache.has(url)) {
				return [url, this._themeCache.get(url)];
			}
			return this._selectTheme(url).then((theme) => {
				this._themeCache.set(url, theme);
				return [url, theme];
			});
		});
	},
	_change: function() {
		this._pick().then(([url, theme]) => {
			this.url = url;
			this.theme = theme;
			Services.obs.notifyObservers(null, 'newtabtools-change', 'background');

			this._startTimer();
		});
	},
	_startTimer: function(forceAwake = false) {
		this._stopTimer();

		if (this.changeInterval > 0) {
			if (!forceAwake && !NewTabUtils.allPages._pages.some(function(p) {
				return Cu.getGlobalForObject(p).document.visibilityState == 'visible';
			})) {
				// If no new tab pages can be seen, stop changing the image.
				this._asleep = true;
				return;
			}
			this._timer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
			this._timer.initWithCallback(this._delayedChange.bind(this), this.changeInterval * 60000, Ci.nsITimer.TYPE_ONE_SHOT);
		}
	},
	_stopTimer: function() {
		if (this._timer) {
			// Only one time at once, please!
			this._timer.cancel();
			delete this._timer;
		}
	},
	wakeUp: function() {
		// This is called by newTabTools.onVisible
		if (this.mode == BackgroundImage.MODE_FOLDER_SHARED && this._asleep) {
			this._asleep = false;
			this._startTimer(true);
		}
	},
	observe: function(subject, topic, data) {
		switch (topic) {
		case 'idle':
			idleService.removeIdleObserver(this, this.IDLE_TIME);
			this._change();
			break;
		case 'nsPref:changed':
			this._readPrefs();
			this._stopTimer();

			if (data == BackgroundImage.PREF_DIRECTORY) {
				this._state = 'unready';
				this._init();
			}

			if (this.mode == BackgroundImage.MODE_FOLDER_SHARED) {
				this._startTimer();
			}
			Services.obs.notifyObservers(null, 'newtabtools-change', 'background');
			break;
		}
	},
	_delayedChange: function() {
		if (idleService.idleTime > this.IDLE_TIME * 1000) {
			this._change();
		} else {
			idleService.addIdleObserver(this, this.IDLE_TIME);
		}
	},
	_selectTheme: function(url) {
		return new Promise(function(resolve) {
			let doc = Services.wm.getMostRecentWindow('navigator:browser').document;
			let c = doc.createElementNS(XHTMLNS, 'canvas');
			c.width = c.height = 100;
			let x = c.getContext('2d');
			let i = doc.createElementNS(XHTMLNS, 'img');
			i.onload = function() {
				try {
					x.drawImage(i, 0, 0, i.width, i.height, 0, 0, 100, 100);
					let d = x.getImageData(0, 0, 100, 100).data;
					let b = 0;
					let j = 0;
					for (; j < 19996; j++) {
						let v = d[j++] + d[j++] + d[j++];
						if (v >= 384) {
							b++;
						}
					}
					for (; j < 40000; j++) {
						let v = d[j++] + d[j++] + d[j++];
						if (v >= 384) {
							if (++b > 5000) {
								resolve('light');
								return;
							}
						}
					}
					resolve('dark');
				} catch (ex) {
					Cu.reportError(ex);
				}
			};
			i.src = url;
		});
	},
	QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.nsISupportsWeakReference])
};
BackgroundImage._readPrefs();
Services.prefs.addObserver('extensions.newtabtools.background.', BackgroundImage, true);

var ThumbnailPrefs = {
	PREF_WIDTH: 'toolkit.pageThumbs.minWidth',
	PREF_HEIGHT: 'toolkit.pageThumbs.minHeight',
	PREF_DELAY: 'extensions.newtabtools.thumbs.prefs.delay',

	hasBeenSet: false,
	setOnce: function(width, height) {
		if (this.hasBeenSet || this.delay < 0) {
			return;
		}
		this.hasBeenSet = true;

		Services.prefs.setIntPref(this.PREF_WIDTH, width);
		Services.prefs.setIntPref(this.PREF_HEIGHT, height);
		Services.ppmm.broadcastAsyncMessage('NewTabTools:uncacheThumbnailPrefs');
	},
	observe: function() {
		this.delay = Services.prefs.getIntPref(ThumbnailPrefs.PREF_DELAY);
	},
	QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.nsISupportsWeakReference]),
};
XPCOMUtils.defineLazyGetter(ThumbnailPrefs, 'delay', function() {
	Services.prefs.addObserver(ThumbnailPrefs.PREF_DELAY, ThumbnailPrefs, true);
	return Services.prefs.getIntPref(ThumbnailPrefs.PREF_DELAY);
});
