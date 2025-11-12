# Sortable File Explorer

An alternative file explorer for Obsidian with drag & drop reordering for custom sorting, multi-select capabilities, and full navigation features.

## Features

### Core Functionality
- **Enhanced File Explorer**: Adds a new custom user sortable file explorer.
- **Custom Sorting**: Drag and drop files and folders to create your own organization system
- **Multi-Selection**: Use Shift-click for range selection or Ctrl/Cmd-click for individual items
- **Intelligent Drag & Drop**: Visual indicators show exactly where items will be placed
- **Inline Renaming**: Rename files and folders directly in the explorer

### Advanced Features
- **Batch Operations**: Move, duplicate, or delete multiple files at once
- **Smart Drop Zones**: Drop onto folder centers to move items inside, or between items to reorder
- **External File Import**: Drag files from your operating system directly into Obsidian
- **Accurate Drop Highlighting**: When dragging from Finder/Explorer, only the specific folder that will receive the drop is highlighted (or the root if over whitespace/left gutter).

### User Experience
- **Context Menus**: Right-click for file and folder operations
- **Keyboard Friendly**: Supports standard selection patterns and navigation
- **Visual Feedback**: Clear indicators for drag operations and selections
- **Stable Performance**: Optimized for large vaults with throttled operations

## Installation

### From Community Plugins (Recommended)
1. Open Obsidian Settings → Community plugins
2. Browse community plugins and search for "Sortable File Explorer"
3. Install and enable the plugin
4. The sortable file explorer will appear in your sidebar

### Manual Installation
1. Download the plugin files from the releases page
2. Extract to `[your vault]/.obsidian/plugins/sortable-file-explorer/`
3. Restart Obsidian or reload community plugins
4. Enable "Sortable File Explorer" in Settings → Community plugins

## Usage

### Getting Started
1. **Open the View**: Click the folder icon in the ribbon or use "View → Sortable File Explorer"
2. **Basic Navigation**: Single-click files to open them, folders to expand/collapse
3. **Multi-Select**: Hold Shift for range selection. Cmd/Ctrl-click behavior is configurable (new tab vs. multi-select).

### File Operations
- **Rename**: Right-click → "Rename..." or use the rename command
- **Move Files**: Drag items to new locations or use right-click → "Move to..."
- **Create Items**: Right-click in empty space → "New note/folder/canvas"
- **Duplicate**: Right-click → "Duplicate" to copy files or entire folders

### Organization Features
- **Custom Order**: Drag files and folders to arrange them in your preferred order
- **Drop Indicators**: Blue lines show exactly where items will be placed when dropping
- **Folder Operations**: Drop onto folder centers to move items inside
- **Batch Moving**: Select multiple items and drag them together

## Compatibility

- **Obsidian Version**: Requires Obsidian 1.9.0 or newer because this is what I tested with. It may work on past verions.
- **Plugin Compatibility**: Designed to incorporate the functionality of other plugins which add things to the file explorer's context menu; however, there are certainly some plugins out there which don't work. 

### Mobile support (iOS/Android)

- The plugin loads on mobile and preserves/reflects your custom sort order created on desktop.
- Drag-and-drop reordering and some desktop-oriented actions (right-click context menus, certain keyboard shortcuts) are not available on mobile due to long‑press/touch limitations.
- You can still navigate, open, and rename items via Obsidian’s core mobile actions. For reordering, use the desktop app; changes will display correctly on mobile.

## Settings and Customization

The plugin preserves your custom file order and folder collapse states automatically. Sorting data and settings are stored in a data.json inside the plugin's directory.

### Cmd/Ctrl click action

- Choose what happens when you Cmd (macOS) or Ctrl (Windows/Linux) click a file:
	- Open file in a new tab (vanilla action)
	- Select multiple (toggle selection)

### Keyboard shortcuts

These mirror the default File Explorer’s common behaviors:

- Arrow Up/Down: Move selection
- Arrow Right: Expand folder; if already expanded, moves into first child
- Arrow Left: Collapse folder; if already collapsed or on a file, move to parent folder
- Enter: Open file; toggle folder expand/collapse
- Cmd/Ctrl+Enter: Open file in a new tab
- F2: Rename selected item
- Cmd/Ctrl+A: Select all items
- Escape: Clear selection

## License

This plugin is licensed under the MIT License. See [LICENSE.txt](LICENSE.txt) for full details.

## Author

Created by [Ninjalope](https://github.com/ninjalope)

If you find this plugin helpful, consider [supporting development](https://ko-fi.com/ninjalope) ☕

---

**Note**: This plugin modifies the file explorer interface but does not change how Obsidian stores or manages your files. Your vault structure and data remain the same.
