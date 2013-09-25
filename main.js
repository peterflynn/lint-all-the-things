/*
 * Copyright (c) 2013 Peter Flynn.
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */


/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4 */
/*global define, brackets, $, CSSLint, jsonlint */

define(function (require, exports, module) {
    "use strict";
    
    // Brackets modules
    var CodeInspection      = brackets.getModule("language/CodeInspection"),
        CommandManager      = brackets.getModule("command/CommandManager"),
        Commands            = brackets.getModule("command/Commands"),
        Menus               = brackets.getModule("command/Menus"),
        FileIndexManager    = brackets.getModule("project/FileIndexManager"),
        ProjectManager      = brackets.getModule("project/ProjectManager"),
        NativeFileSystem    = brackets.getModule("file/NativeFileSystem").NativeFileSystem,
        EditorManager       = brackets.getModule("editor/EditorManager"),
        CollectionUtils     = brackets.getModule("utils/CollectionUtils"),
        Async               = brackets.getModule("utils/Async"),
        StringUtils         = brackets.getModule("utils/StringUtils"),
        Dialogs             = brackets.getModule("widgets/Dialogs");
    
    
    /* E.g., for Brackets core-team-owned source:
            /extensions/dev/       (want to exclude any personal code...)
            /thirdparty/
            /3rdparty/
            /node_modules/
            /widgets/bootstrap-
            /brackets/tasks/
            /unittest-files/
            /spec/JSUtils-test-files/
            /spec/CSSUtils-test-files/
            /spec/DocumentCommandHandlers-test-files/
            /spec/NodeConnection-test-files/
            /spec/ExtensionLoader-test-files/
            /perf/OpenFile-perf-files/
            
            /samples/_disabled/
            TokenStream w
            JSUtils w
            test quickedit
     */
    var filterStrings = [];
    
    // (code borrowed from SLOC extension)
    function filter(fileInfo) {
        var path = fileInfo.fullPath;
        var i;
        for (i = 0; i < filterStrings.length; i++) {
            if (path.indexOf(filterStrings[i]) !== -1) {
                return false;
            }
        }
        return true;
    }
    
    
    /** Shows a large message in a dialog with a scrolling panel. Based on BracketsReports extension. */
    function showResult(title, message) {
        var html = "<div style='-webkit-user-select:text; cursor: auto; padding:10px; max-height:250px; overflow:auto'>";
        
        message = StringUtils.htmlEscape(message);
        message = message.replace(/\n/g, "<br>");
        message = message.replace(/ {2}/g, " &nbsp;");
        message = message.replace(/\t/g, "&nbsp;&nbsp;&nbsp;&nbsp;");
        html += message;
        
        html += "</div>";
        
        Dialogs.showModalDialog(Dialogs.DIALOG_ID_ERROR, title, html)
            .done(function () { EditorManager.focusEditor(); });
    }
    
    
    function getAllResults(progress) {
        var result = new $.Deferred();
        
        // Figure out what "all the things" actually are
        var lintables = [];
        FileIndexManager.getFileInfoList("all").done(function (fileInfos) {
            fileInfos.forEach(function (fileInfo) {
                if (filter(fileInfo) && CodeInspection.getProvider({ fullPath: fileInfo.fullPath })) {
                    lintables.push(fileInfo.fullPath);
                }
            });
            
            progress.begin(lintables.length);
            
            var results = {};
            function lintOne(fullPath) {
                var onePromise = CodeInspection.inspectFile(new NativeFileSystem.FileEntry(fullPath));
                onePromise.done(function (oneResult) {
                    if (oneResult && oneResult.errors.length) {
                        results[fullPath] = oneResult;
                    }
                    progress.increment();
                });
                return onePromise;
            }
            
            Async.doInParallel(lintables, lintOne, false).done(function () {
                result.resolve(results);
            });
        });
        
        return result.promise();
    }
    
    // (code borrowed from SLOC extension)
    function getExclusions() {
        var $textarea;
        var message = "Exclude files/folders containing any of these substrings:<br><textarea id='lint-excludes' style='width:400px;height:160px'></textarea>";
        var promise = Dialogs.showModalDialog(Dialogs.DIALOG_ID_ERROR, "Project Linting", message);
        
        promise.done(function (btnId) {
            if (btnId === Dialogs.DIALOG_BTN_OK) {  // as opposed so dialog's "X" button
                var substrings = $textarea.val();
                filterStrings = substrings.split("\n");
                filterStrings = filterStrings.map(function (substr) {
                    return substr.trim();
                });
                filterStrings = filterStrings.filter(function (substr) {
                    return substr !== "";
                });
            }
        });
        
        // store now since it'll be orphaned by the time done() handler runs
        $textarea = $("#lint-excludes");
        
        // prepopulate with last-used filter within session
        // TODO: save/restore last-used string in prefs
        $textarea.val(filterStrings.join("\n"));
        $textarea.focus();
        
        return promise;
    }
    
    function lintAll() {
        getExclusions().done(function (btnId) {
            if (btnId !== Dialogs.DIALOG_BTN_OK) {  // i.e. dialog's "X" button
                return;
            }
            
            var progressCallbacks = {
                begin: function (totalFiles) { console.log("Need to lint " + totalFiles + " files"); },
                increment: function () {}
            };
            
            getAllResults(progressCallbacks).done(function (results) {
                var runningTotal = 0,
                    filesTotal = 0,
                    message = "";
                CollectionUtils.forEach(results, function (oneResult, fullPath) {
                    message += ProjectManager.makeProjectRelativeIfPossible(fullPath) + ":\n";
                    oneResult.errors.forEach(function (error) {
                        message += "    " + error.pos.line + ": " + error.message + "\n";
                    });
                    filesTotal++;
                    runningTotal += oneResult.errors.length;
                    message += "\n";
                });
                
                if (runningTotal === 0) {
                    message = "Awesome job! No lint problems here.";
                } else {
                    // Prepend summary
                    message = runningTotal + " lint problems in " + filesTotal + " files.\n\n" + message;
                }
                
                // TODO: show in footer panel a la Find All, making it easy to jump to each offending line
                showResult("Lint Results", message);
            });
        });
    }
    
    
    var COMMAND_ID = "pflynn.lint-ALL-the-things";
    
    CommandManager.register("Lint Whole Project", COMMAND_ID, lintAll);
    
    var menu = Menus.getMenu(Menus.AppMenuBar.VIEW_MENU);
    menu.addMenuItem(COMMAND_ID, null, Menus.AFTER, Commands.VIEW_TOGGLE_INSPECTION);
});