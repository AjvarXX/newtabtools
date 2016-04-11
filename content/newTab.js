/*
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this file,
You can obtain one at http://mozilla.org/MPL/2.0/.
*/
/* globals PinnedLinks, BlockedLinks, Grid, Updater */

/* globals Components, PageThumbsStorage, Services, XPCOMUtils */
var { classes: Cc, interfaces: Ci, utils: Cu } = Components;

Cu.import('resource://gre/modules/PageThumbs.jsm');
Cu.import('resource://gre/modules/Services.jsm');
Cu.import('resource://gre/modules/XPCOMUtils.jsm');
/* globals GridPrefs, TileData, SavedThumbs, ThumbnailPrefs */
Cu.import('chrome://newtabtools/content/newTabTools.jsm');

/* globals FileUtils, NetUtil, SessionStore, OS, PageThumbUtils, PlacesUtils, PrivateBrowsingUtils */
XPCOMUtils.defineLazyModuleGetter(this, 'FileUtils', 'resource://gre/modules/FileUtils.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'NetUtil', 'resource://gre/modules/NetUtil.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'SessionStore', 'resource:///modules/sessionstore/SessionStore.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'OS', 'resource://gre/modules/osfile.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'PageThumbUtils', 'resource://gre/modules/PageThumbUtils.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'PlacesUtils', 'resource://gre/modules/PlacesUtils.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'PrivateBrowsingUtils', 'resource://gre/modules/PrivateBrowsingUtils.jsm');

/* globals autocompleteService */
XPCOMUtils.defineLazyServiceGetter(
	this, 'autocompleteService', '@mozilla.org/autocomplete/search;1?name=history', 'nsIAutoCompleteSearch'
);

var HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

function inPrivateBrowsingMode() {
	return PrivateBrowsingUtils.isContentWindowPrivate(window);
}

var newTabTools = {
	_previousAutocompleteString: '',
	_previousAutocompleteResult: null,
	autocomplete: function(input) {
		if (!!this._previousAutocompleteString && input.value.indexOf(this._previousAutocompleteString) > -1) {
			return;
		}
		if (input.value.length < 2) {
			while (this.pinURLAutocomplete.lastChild) {
				this.pinURLAutocomplete.lastChild.remove();
			}
			return;
		}
		autocompleteService.stopSearch();
		autocompleteService.startSearch(input.value, '', this._previousAutocompleteResult, {
			onSearchResult: (function(s, r) {
				for (let i = 0; i < r.matchCount; i++) {
					let option = document.createElement('option');
					option.textContent = r.getValueAt(i);
					this.pinURLAutocomplete.appendChild(option);
				}
				this._previousAutocompleteResult = r;
				this._previousAutocompleteString = input.value;
			}).bind(this)
		});
	},
	launcherOnClick: function(event) {
		switch (event.originalTarget.id) {
		case 'downloads':
			newTabTools.browserWindow.BrowserDownloadsUI();
			break;
		case 'bookmarks':
			newTabTools.browserWindow.PlacesCommandHook.showPlacesOrganizer('AllBookmarks');
			break;
		case 'history':
			newTabTools.browserWindow.PlacesCommandHook.showPlacesOrganizer('History');
			break;
		case 'addons':
			newTabTools.browserWindow.BrowserOpenAddonsMgr();
			break;
		case 'sync':
			newTabTools.browserWindow.openPreferences('paneSync');
			break;
		case 'settingsWin':
		case 'settingsUnix':
			newTabTools.browserWindow.openPreferences();
			break;
		case 'restorePreviousSession':
			SessionStore.restoreLastSession();
			break;
		}
	},
	get selectedSite() {
		return Grid.sites[this._selectedSiteIndex];
	},
	optionsOnClick: function(event) {
		if (event.originalTarget.disabled) {
			return;
		}
		let id = event.originalTarget.id;
		switch (id) {
		case 'options-pinURL':
			let link = this.pinURLInput.value;
			let linkURI = Services.io.newURI(link, null, null);
			event.originalTarget.disabled = true;
			PlacesUtils.promisePlaceInfo(linkURI).then(function(info) {
				newTabTools.pinURL(linkURI.spec, info.title);
				newTabTools.pinURLInput.value = '';
				event.originalTarget.disabled = false;
			}, function() {
				newTabTools.pinURL(linkURI.spec, '');
				newTabTools.pinURLInput.value = '';
				event.originalTarget.disabled = false;
			}).then(null, Cu.reportError);
			break;
		case 'options-previous-row-tile':
			this.selectedSiteIndex = (this._selectedSiteIndex - GridPrefs.gridColumns + Grid.cells.length) % Grid.cells.length;
			break;
		case 'options-previous-tile':
		case 'options-next-tile':
			let { gridColumns } = GridPrefs;
			let row = Math.floor(this._selectedSiteIndex / gridColumns);
			let column = (this._selectedSiteIndex + (id == 'options-previous-tile' ? -1 : 1) + gridColumns) % gridColumns;

			this.selectedSiteIndex = row * gridColumns + column;
			break;
		case 'options-next-row-tile':
			this.selectedSiteIndex = (this._selectedSiteIndex + GridPrefs.gridColumns) % Grid.cells.length;
			break;
		case 'options-thumbnail-browse':
		case 'options-bg-browse':
			let fp = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
			fp.init(window, document.title, Ci.nsIFilePicker.modeOpen);
			fp.appendFilters(Ci.nsIFilePicker.filterImages);
			if (fp.show() == Ci.nsIFilePicker.returnOK) {
				if (id == 'options-thumbnail-browse') {
					this.setThumbnailInput.value = fp.fileURL.spec;
					newTabTools.setThumbnailButton.disabled = false;
				} else {
					this.setBackgroundInput.value = fp.fileURL.spec;
					newTabTools.setBackgroundButton.disabled = false;
				}
			}
			break;
		case 'options-thumbnail-set':
			this.setThumbnail(this.selectedSite, this.setThumbnailInput.value);
			break;
		case 'options-thumbnail-remove':
			this.setThumbnail(this.selectedSite, null);
			break;
		case 'options-thumbnail-refresh':
			event.originalTarget.disabled = true;
			SavedThumbs.forceReloadThumbnail(this.selectedSite.url).then(function() {
				event.originalTarget.disabled = false;
			});
			break;
		case 'options-bgcolor-displaybutton':
			this.setBgColourInput.click();
			break;
		case 'options-bgcolor-set':
			TileData.set(this.selectedSite.url, 'backgroundColor', this.setBgColourInput.value);
			this.siteThumbnail.style.backgroundColor = this.setBgColourInput.value;
			this.resetBgColourButton.disabled = false;
			break;
		case 'options-bgcolor-reset':
			TileData.set(this.selectedSite.url, 'backgroundColor', null);
			this.siteThumbnail.style.backgroundColor =
				this.setBgColourInput.value =
				this.setBgColourDisplay.style.backgroundColor = null;
			this.setBgColourButton.disabled =
				this.resetBgColourButton.disabled = true;
			break;
		case 'options-title-set':
			this.setTitle(this.selectedSite, this.setTitleInput.value);
			break;
		case 'options-title-reset':
			this.setTitle(this.selectedSite, null);
			break;
		case 'options-bg-set':
			if (this.setBackgroundInput.value) {
				NetUtil.asyncFetch({
					uri: this.setBackgroundInput.value,
					loadingNode: document,
					contentPolicyType: Ci.nsIContentPolicyBase.TYPE_IMAGE
				}, function(inputStream, status) {
					if (!Components.isSuccessCode(status)) {
						return;
					}
					let fos = FileUtils.openSafeFileOutputStream(this.backgroundImageFile);
					NetUtil.asyncCopy(inputStream, fos, function() {
						FileUtils.closeSafeFileOutputStream(fos);
						Services.obs.notifyObservers(null, 'newtabtools-change', 'background');
					}.bind(this));
				}.bind(this));
			}
			break;
		case 'options-bg-remove':
			if (this.backgroundImageFile.exists())
				this.backgroundImageFile.remove(true);
			Services.obs.notifyObservers(null, 'newtabtools-change', 'background');
			break;
		case 'options-donate':
			let url = 'https://addons.mozilla.org/addon/new-tab-tools/about';
			newTabTools.browserWindow.openLinkIn(url, 'current', {});
			break;
		}
	},
	optionsOnChange: function(event) {
		if (event.originalTarget.disabled) {
			return;
		}
		switch (event.originalTarget.type) {
		case 'radio':
		case 'select-one':
			ThumbnailPrefs.hasBeenSet = false;
			if (event.originalTarget.name == 'launcher') {
				this.prefs.setIntPref(event.originalTarget.name, parseInt(event.originalTarget.value, 10));
			} else {
				this.prefs.setCharPref(event.originalTarget.name, event.originalTarget.value);
			}
			Grid.setThumbnailPrefs();
			break;
		case 'number':
			ThumbnailPrefs.hasBeenSet = false;
			// Prefs set by grid redrawing itself.
			/* falls through */
		case 'range':
			this.prefs.setIntPref(event.originalTarget.name, parseInt(event.originalTarget.value, 10));
			break;
		case 'checkbox':
			let checked = event.originalTarget.checked;
			if (event.originalTarget.hasAttribute('inverted')) {
				checked = !checked;
			}
			this.prefs.setBoolPref(event.originalTarget.name, checked);
			break;
		}
	},
	pinURL: function(link, title) {
		let index = Grid.sites.length - 1;
		for (var i = 0; i < Grid.sites.length; i++) {
			let s = Grid.sites[i];
			if (!s || !s.isPinned()) {
				index = i;
				break;
			}
		}

		BlockedLinks.unblock(link);
		PinnedLinks.pin({url: link, title: title}, index);
		Updater.updateGrid();
	},
	onTileChanged: function(url, whatChanged) {
		for (let site of Grid.sites) {
			if (!!site && site.url == url) {
				switch (whatChanged) {
				case 'backgroundColor':
					site._querySelector('.newtab-thumbnail').style.backgroundColor = TileData.get(url, 'backgroundColor');
					break;
				case 'thumbnail':
					site.refreshThumbnail();
					this.selectedSiteIndex = this._selectedSiteIndex;
					break;
				case 'title':
					site._addTitleAndFavicon();
					break;
				}
			}
		}
	},
	setThumbnail: function(site, src) {
		let leafName = SavedThumbs.getThumbnailLeafName(site.url);
		let path = SavedThumbs.getThumbnailPath(site.url, leafName);
		let file = FileUtils.File(path);
		let existed = SavedThumbs.hasSavedThumb(site.url, leafName);
		if (existed) {
			file.permissions = 0644;
			file.remove(true);
		}

		if (!src) {
			if (!existed) {
				path = PageThumbsStorage.getFilePathForURL(site.url);
				file = FileUtils.File(path);
				if (file.exists()) {
					file.permissions = 0644;
					file.remove(true);
				}
			}

			SavedThumbs.removeSavedThumb(site.url, leafName);
			this.removeThumbnailButton.blur();
			return;
		}

		let image = new Image();
		image.onload = function() {
			let [thumbnailWidth, thumbnailHeight] = PageThumbUtils.getThumbnailSize();
			let scale = Math.min(Math.max(thumbnailWidth / image.width, thumbnailHeight / image.height), 1);

			let canvas = document.createElementNS(HTML_NAMESPACE, 'canvas');
			canvas.mozOpaque = false;
			canvas.mozImageSmoothingEnabled = true;
			canvas.width = image.width * scale;
			canvas.height = image.height * scale;
			let ctx = canvas.getContext('2d');
			ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

			canvas.toBlob(function(blob) {
				let reader = new FileReader();
				reader.onloadend = function() {
					let inputStream = Cc['@mozilla.org/io/arraybuffer-input-stream;1']
					.createInstance(Ci.nsIArrayBufferInputStream);
					inputStream.setData(reader.result, 0, reader.result.byteLength);
					let outputStream = FileUtils.openSafeFileOutputStream(file);
					NetUtil.asyncCopy(inputStream, outputStream, function() {
						FileUtils.closeSafeFileOutputStream(outputStream);
						SavedThumbs.addSavedThumb(site.url, leafName);
					});
				};
				reader.readAsArrayBuffer(blob);
			}, 'image/png');
		};
		image.src = src;
	},
	setTitle: function(site, title) {
		TileData.set(site.url, 'title', title);
		this.resetTitleButton.disabled = !title;
		if (!title) {
			this.setTitleInput.value = site.title;
			this.resetTitleButton.blur();
		}
	},
	get backgroundImageFile() {
		return FileUtils.getFile('ProfD', ['newtab-background'], true);
	},
	get backgroundImageURL() {
		return Services.io.newFileURI(this.backgroundImageFile);
	},
	refreshBackgroundImage: function() {
		if (this.backgroundImageFile.exists()) {
			document.body.style.backgroundImage =
				'url("' + this.backgroundImageURL.spec + '?' + this.backgroundImageFile.lastModifiedTime + '")';
			this.removeBackgroundButton.disabled = false;
		} else {
			document.body.style.backgroundImage = null;
			this.removeBackgroundButton.disabled = true;
			this.removeBackgroundButton.blur();
		}
	},
	updateUI: function() {
		let launcherPosition = this.prefs.getIntPref('launcher');
		document.querySelector('[name="launcher"]').value = launcherPosition;
		if (launcherPosition) {
			let positionNames = ['top', 'right', 'bottom', 'left'];
			document.documentElement.setAttribute('launcher', positionNames[launcherPosition - 1]);
		} else {
			document.documentElement.removeAttribute('launcher');
		}

		let theme = this.prefs.getCharPref('theme');
		this.themePref.querySelector('[value="' + theme + '"]').checked = true;
		document.documentElement.setAttribute('theme', theme);

		let containThumbs = this.prefs.getBoolPref('thumbs.contain');
		document.querySelector('[name="thumbs.contain"]').checked = containThumbs;
		document.documentElement.classList[containThumbs ? 'add' : 'remove']('containThumbs');

		let hideButtons = this.prefs.getBoolPref('thumbs.hidebuttons');
		document.querySelector('[name="thumbs.hidebuttons"]').checked = !hideButtons;
		document.documentElement.classList[hideButtons ? 'add' : 'remove']('hideButtons');

		let hideFavicons = this.prefs.getBoolPref('thumbs.hidefavicons');
		document.querySelector('[name="thumbs.hidefavicons"]').checked = !hideFavicons;
		document.documentElement.classList[hideFavicons ? 'add' : 'remove']('hideFavicons');

		let titleSize = this.prefs.getCharPref('thumbs.titlesize');
		document.querySelector('[name="thumbs.titlesize"]').value = titleSize;
		document.documentElement.setAttribute('titlesize', titleSize);

		let gridMargin = ['small', 'small', 'small', 'small'];
		let prefGridMargin = this.prefs.getCharPref('grid.margin').split(' ', 4);
		if (prefGridMargin.length == 4) {
			gridMargin = prefGridMargin;
		}
		document.querySelector('[name="grid.margin"]').value = gridMargin.join(' ');
		this.setGridMargin('top', gridMargin[0]);
		this.setGridMargin('right-top', gridMargin[1]);
		this.setGridMargin('right-bottom', gridMargin[1]);
		this.setGridMargin('bottom', gridMargin[2]);
		this.setGridMargin('left-bottom', gridMargin[3]);
		this.setGridMargin('left-top', gridMargin[3]);

		let gridSpacing = this.prefs.getCharPref('grid.spacing');
		document.querySelector('[name="grid.spacing"]').value = gridSpacing;
		document.documentElement.setAttribute('spacing', gridSpacing);

		let opacity = Math.max(0, Math.min(100, this.prefs.getIntPref('foreground.opacity')));
		document.querySelector('[name="foreground.opacity"]').value = opacity;
		document.documentElement.style.setProperty('--opacity', opacity / 100);

		let showHistory = this.prefs.getBoolPref('historytiles.show');
		document.querySelector('[name="historytiles.show"]').checked = showHistory;

		let showRecent = this.prefs.getBoolPref('recent.show');
		document.querySelector('[name="recent.show"]').checked = showRecent;
		this.trimRecent();

		let dataCollection = this.prefs.getBoolPref('datacollection.optin');
		document.querySelector('[name="datacollection.optin"]').checked = dataCollection;

		if ('Grid' in window) {
			requestAnimationFrame(Grid.cacheCellPositions);
		}
	},
	updateGridPrefs: function() {
		document.querySelector('[name="rows"]').value = GridPrefs.gridRows;
		document.querySelector('[name="columns"]').value = GridPrefs.gridColumns;
	},
	setGridMargin: function(piece, size) {
		let pieceElement = document.getElementById('newtab-margin-' + piece);
		pieceElement.classList.remove('medium');
		pieceElement.classList.remove('large');
		if (size == 'medium' || size == 'large') {
			pieceElement.classList.add(size);
		}
	},
	startRecent: function() {
		let tabContainer = this.browserWindow.gBrowser.tabContainer;
		let handler = this.refreshRecent.bind(this);
		tabContainer.addEventListener('TabOpen', handler, false);
		tabContainer.addEventListener('TabClose', handler, false);

		window.addEventListener('unload', function() {
			tabContainer.removeEventListener('TabOpen', handler, false);
			tabContainer.removeEventListener('TabClose', handler, false);
		}, false);
		handler();

		let previousWidth = window.innerWidth;
		window.addEventListener('resize', () => {
			if (window.innerWidth != previousWidth) {
				previousWidth = window.innerWidth;
				this.trimRecent();
			}
		});
	},
	refreshRecent: function(event) {
		if (event && event.originalTarget.linkedBrowser.contentWindow == window) {
			return;
		}

		if (!this.prefs.getBoolPref('recent.show')) {
			this.recentList.hidden = true;
			return;
		}

		for (let element of this.recentList.querySelectorAll('a')) {
			this.recentList.removeChild(element);
		}

		let added = 0;
		let undoItems = JSON.parse(SessionStore.getClosedTabData(this.browserWindow));
		for (let i = 0; i < undoItems.length; i++) {
			let item = undoItems[i];
			let index = i;
			let iconURL;
			let url;

			if (item.image) {
				iconURL = item.image;
				if (/^https?:/.test(iconURL)) {
					iconURL = 'moz-anno:favicon:' + iconURL;
				}
			} else {
				iconURL = 'chrome://mozapps/skin/places/defaultFavicon.png';
			}

			let tabData = item.state;
			let activeIndex = (tabData.index || tabData.entries.length) - 1;
			if (activeIndex >= 0 && tabData.entries[activeIndex]) {
				url = tabData.entries[activeIndex].url;
				if (url == 'about:newtab' && tabData.entries.length == 1) {
					continue;
				}
			}

			let a = document.createElementNS(HTML_NAMESPACE, 'a');
			a.href = url;
			a.className = 'recent';
			a.title = (item.title == url ? item.title : item.title + '\n' + url);
			a.onclick = function() {
				newTabTools.browserWindow.undoCloseTab(index);
				return false;
			}; // jshint ignore:line
			let img = document.createElementNS(HTML_NAMESPACE, 'img');
			img.className = 'favicon';
			img.src = iconURL;
			a.appendChild(img);
			a.appendChild(document.createTextNode(item.title));
			this.recentList.appendChild(a);
			added++;
		}
		this.trimRecent();
		this.recentList.hidden = !added;
	},
	trimRecent: function() {
		this.recentList.style.width = '0';

		let width = this.recentListOuter.clientWidth;
		let elements = document.querySelectorAll('.recent');

		for (let recent of elements) {
			// see .recent
			let right = recent.offsetLeft + recent.offsetWidth - this.recentList.offsetLeft + 4;
			if (right == 4) {
				requestAnimationFrame(this.trimRecent.bind(this));
				return;
			}
			if (right <= width) {
				this.recentList.style.width = right + 'px';
			} else {
				break;
			}
		}
	},
	onVisible: function() {
		this.startRecent();
		if (!this.prefs.getBoolPref('optionspointershown')) {
			this.optionsTogglePointer.hidden = false;
			this.optionsTogglePointer.style.animationPlayState = 'running';
		}
		this.onVisible = function() {};
	},
	set selectedSiteIndex(index) { // jshint ignore:line
		this._selectedSiteIndex = index;
		let site = this.selectedSite;
		let disabled = site == null;

		this.setThumbnailInput.value = '';
		this.browseThumbnailButton.disabled =
			this.setThumbnailInput.disabled =
			this.setTitleInput.disabled =
			this.setTitleButton.disabled =
			this.setBgColourDisplay.parentNode.disabled = disabled;

		if (disabled) {
			this.siteThumbnail.style.backgroundImage =
				this.siteThumbnail.style.backgroundColor =
				this.setBgColourDisplay.style.backgroundColor = null;
			this.siteURL.textContent = this.strings.GetStringFromName('tileurl.empty');
			this.setTitleInput.value = '';
			this.removeThumbnailButton.disabled =
				this.captureThumbnailButton.disabled =
				this.setBgColourButton.disabled =
				this.resetBgColourButton.disabled =
				this.resetTitleButton.disabled = true;
			return;
		}

		SavedThumbs.getThumbnailURL(site.url).then((thumbnail) => {
			this.siteThumbnail.style.backgroundImage = 'url("' + thumbnail + '")';
			if (thumbnail.startsWith('file:')) {
				this.removeThumbnailButton.disabled = false;
				this.captureThumbnailButton.disabled = true;
				this.siteThumbnail.classList.add('custom-thumbnail');
			} else {
				OS.File.exists(PageThumbsStorage.getFilePathForURL(site.url)).then((exists) => {
					this.removeThumbnailButton.disabled = !exists;
					this.captureThumbnailButton.disabled = false;
				});
				this.siteThumbnail.classList.remove('custom-thumbnail');
			}
		});

		let { gridRows, gridColumns } = GridPrefs;
		let row = Math.floor(index / gridColumns);
		let column = index % gridColumns;
		this.tilePreviousRow.style.opacity = row == 0 ? 0.25 : null;
		this.tilePrevious.style.opacity = column == 0 ? 0.25 : null;
		this.tileNext.style.opacity = (column + 1 == gridColumns) ? 0.25 : null;
		this.tileNextRow.style.opacity = (row + 1 == gridRows) ? 0.25 : null;

		this.siteURL.textContent = site.url;
		let backgroundColor = TileData.get(site.url, 'backgroundColor');
		this.siteThumbnail.style.backgroundColor =
			this.setBgColourInput.value =
			this.setBgColourDisplay.style.backgroundColor = backgroundColor;
		this.setBgColourButton.disabled =
			this.resetBgColourButton.disabled = !backgroundColor;
		let title = TileData.get(site.url, 'title');
		this.setTitleInput.value = title || site.title || site.url;
		this.resetTitleButton.disabled = title === null;
	},
	toggleOptions: function() {
		if (document.documentElement.hasAttribute('options-hidden')) {
			this.optionsTogglePointer.hidden = true;
			this.prefs.setBoolPref('optionspointershown', true);
			document.documentElement.removeAttribute('options-hidden');
			this.selectedSiteIndex = 0;
			this.pinURLInput.focus();
		} else {
			this.hideOptions();
		}
	},
	hideOptions: function() {
		document.documentElement.setAttribute('options-hidden', 'true');
	}
};

(function() {
	function getTopWindow() {
		return window.QueryInterface(Ci.nsIInterfaceRequestor)
		.getInterface(Ci.nsIWebNavigation)
		.QueryInterface(Ci.nsIDocShellTreeItem)
		.rootTreeItem
		.QueryInterface(Ci.nsIInterfaceRequestor)
		.getInterface(Ci.nsIDOMWindow)
		.wrappedJSObject;
	}

	XPCOMUtils.defineLazyGetter(newTabTools, 'browserWindow', function() {
		return getTopWindow();
	});

	XPCOMUtils.defineLazyGetter(newTabTools, 'prefs', function() {
		return Services.prefs.getBranch('extensions.newtabtools.');
	});

	XPCOMUtils.defineLazyGetter(newTabTools, 'strings', function() {
		return Services.strings.createBundle('chrome://newtabtools/locale/newTabTools.properties');
	});

	let uiElements = {
		'page': 'newtab-scrollbox', // used in fx-newTab.js
		'launcher': 'launcher',
		'optionsToggleButton': 'options-toggle',
		'optionsTogglePointer': 'options-toggle-pointer',
		'pinURLInput': 'options-pinURL-input',
		'pinURLAutocomplete': 'autocomplete',
		'tilePreviousRow': 'options-previous-row-tile',
		'tilePrevious': 'options-previous-tile',
		'tileNext': 'options-next-tile',
		'tileNextRow': 'options-next-row-tile',
		'siteThumbnail': 'options-thumbnail',
		'siteURL': 'options-url',
		'browseThumbnailButton': 'options-thumbnail-browse',
		'setThumbnailInput': 'options-thumbnail-input',
		'setThumbnailButton': 'options-thumbnail-set',
		'removeThumbnailButton': 'options-thumbnail-remove',
		'captureThumbnailButton': 'options-thumbnail-refresh',
		'setBgColourInput': 'options-bgcolor-input',
		'setBgColourDisplay': 'options-bgcolor-display',
		'setBgColourButton': 'options-bgcolor-set',
		'resetBgColourButton': 'options-bgcolor-reset',
		'setTitleInput': 'options-title-input',
		'resetTitleButton': 'options-title-reset',
		'setTitleButton': 'options-title-set',
		'backgroundOptions': 'options-bg-group',
		'setBackgroundInput': 'options-bg-input',
		'setBackgroundButton': 'options-bg-set',
		'removeBackgroundButton': 'options-bg-remove',
		'themePref': 'options-theme-pref',
		'recentList': 'newtab-recent',
		'recentListOuter': 'newtab-recent-outer',
		'optionsBackground': 'options-bg',
		'optionsPane': 'options'
	};
	for (let key in uiElements) {
		let value = uiElements[key];
		XPCOMUtils.defineLazyGetter(newTabTools, key, () => document.getElementById(value));
	}

	if (Services.appinfo.OS == 'WINNT') {
		document.getElementById('settingsUnix').style.display = 'none';
		newTabTools.optionsToggleButton.title = document.getElementById('settingsWin').textContent;
	} else {
		document.getElementById('settingsWin').style.display = 'none';
		newTabTools.optionsToggleButton.title = document.getElementById('settingsUnix').textContent;
	}

	let chromeRegistry = Components.classes['@mozilla.org/chrome/chrome-registry;1']
		.getService(Components.interfaces.nsIXULChromeRegistry);
	if (['en-US', 'en-GB'].indexOf(chromeRegistry.getSelectedLocale('newtabtools')) >= 0) {
		document.getElementById('options-datacollection').hidden = false;
	}

	function keyUpHandler(event) {
		if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(event.key) > -1) {
			newTabTools.optionsOnChange(event);
		} else if (event.key == 'Escape') {
			newTabTools.hideOptions();
		}
	}

	newTabTools.optionsToggleButton.addEventListener('click', newTabTools.toggleOptions.bind(newTabTools), false);
	newTabTools.optionsPane.addEventListener('click', newTabTools.optionsOnClick.bind(newTabTools), false);
	newTabTools.optionsPane.addEventListener('change', newTabTools.optionsOnChange.bind(newTabTools), false);
	for (let c of newTabTools.optionsPane.querySelectorAll('select, input[type="range"]')) {
		c.addEventListener('keyup', keyUpHandler);
	}
	newTabTools.launcher.addEventListener('click', newTabTools.launcherOnClick, false);
	newTabTools.setThumbnailInput.addEventListener('keyup', function() {
		newTabTools.setThumbnailButton.disabled = !/^(file|ftp|http|https):\/\//.exec(this.value);
	});
	newTabTools.setBgColourInput.addEventListener('change', function() {
		newTabTools.setBgColourDisplay.style.backgroundColor = this.value;
		newTabTools.setBgColourButton.disabled = false;
	});
	newTabTools.setBackgroundInput.addEventListener('keyup', function() {
		newTabTools.setBackgroundButton.disabled = !/^(file|ftp|http|https):\/\//.exec(this.value);
	});
	window.addEventListener('keypress', function(event) {
		if (event.keyCode == 27) {
			newTabTools.hideOptions();
		}
	});

	newTabTools.refreshBackgroundImage();
	newTabTools.updateUI();
	newTabTools.updateGridPrefs();

	let preloaded = document.visibilityState == 'hidden';
	if (!preloaded) {
		newTabTools.onVisible();
	}

	SessionStore.promiseInitialized.then(function() {
		if (SessionStore.canRestoreLastSession && !inPrivateBrowsingMode()) {
			newTabTools.launcher.setAttribute('session', 'true');
			Services.obs.addObserver({
				observe: function() {
					newTabTools.launcher.removeAttribute('session');
				},
				QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.nsISupportsWeakReference])
			}, 'sessionstore-last-session-cleared', true);
		}
	});
})();
