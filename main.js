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
/*jshint multistr: true */
/*global define, brackets, $, Mustache */

define(function (require, exports, module) {
    "use strict";
    
    // Brackets modules
    var _                   = brackets.getModule("thirdparty/lodash"),
        CodeInspection      = brackets.getModule("language/CodeInspection"),
        CommandManager      = brackets.getModule("command/CommandManager"),
        Commands            = brackets.getModule("command/Commands"),
        Menus               = brackets.getModule("command/Menus"),
        WorkspaceManager    = brackets.getModule("view/WorkspaceManager"),
        ProjectManager      = brackets.getModule("project/ProjectManager"),
        EditorManager       = brackets.getModule("editor/EditorManager"),
        ExtensionUtils      = brackets.getModule("utils/ExtensionUtils"),
        Async               = brackets.getModule("utils/Async"),
        StatusBar           = brackets.getModule("widgets/StatusBar"),
        Dialogs             = brackets.getModule("widgets/Dialogs"),
        PreferencesManager  = brackets.getModule("preferences/PreferencesManager");
   
    
    var resultsPanel;
    
    var prefs = PreferencesManager.getExtensionPrefs("lint-all-the-things");
    prefs.definePreference("exclusions", "Array", "");
    
    /**
     * Want to use the current project's settings even if user happens to have a file from outside the project open. Just passing
     * CURRENT_PROJECT should be enough, but it's not - https://github.com/adobe/brackets/pull/10422#issuecomment-73654748
     */
    function projPrefsContext() {
        var context = _.cloneDeep(PreferencesManager.CURRENT_PROJECT);
        context.path = ProjectManager.getProjectRoot().fullPath;
        return context;
    }
    
    /* E.g., for Brackets core-team-owned source:
            /extensions/dev/
            /thirdparty/
            /3rdparty/
            /node_modules/
            /widgets/bootstrap-
            /unittest-files/
            /spec/JSUtils-test-files/
            /spec/CodeInspection-test-files/
            /spec/CSSUtils-test-files/
            /spec/DocumentCommandHandlers-test-files/
            /spec/NodeConnection-test-files/
            /spec/ExtensionLoader-test-files/
            /perf/OpenFile-perf-files/
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
    
    
    function destroyPanel() {
        resultsPanel.hide();
        resultsPanel.$panel.remove();
        resultsPanel = null;
    }
    
    /** Shows a large message in a dialog with a scrolling panel. Based on BracketsReports extension. */
    function showResult(fileList, totalErrors, indeterminate) {
        
        // (Adapted from the CodeInspection & FindInFiles code)
        var panelHtml = "<div id='allproblems-panel' class='bottom-panel vert-resizable top-resizer'>\
                            <div class='toolbar simple-toolbar-layout'>\
                                <div class='title'></div>\
                                <a href='#' class='close'>&times;</a>\
                            </div>\
                            <div class='table-container resizable-content'></div>\
                        </div>";
        var template = "<table class='bottom-panel-table table table-striped table-condensed row-highlight'>\
                            <tbody>\
                                {{#fileList}}\
                                <tr class='file-section'>\
                                    <td colspan='3'><span class='disclosure-triangle expanded'></span><span class='dialog-filename'>{{displayPath}}</span></td>\
                                </tr>\
                                {{#errors}}\
                                <tr data-fullpath='{{fullPath}}'>\
                                    <td class='line-number' data-character='{{pos.ch}}'>{{friendlyLine}}</td>\
                                    <td>{{message}}</td>\
                                    <td>{{codeSnippet}}</td>\
                                </tr>\
                                {{/errors}}\
                                {{/fileList}}\
                            </tbody>\
                        </table>";
        
        resultsPanel = WorkspaceManager.createBottomPanel("all-problems", $(panelHtml), 100);
        
        var $selectedRow;
        var $tableContainer = resultsPanel.$panel.find(".table-container")
            .on("click", "tr", function (e) {
                var $row = $(e.currentTarget);
                if ($selectedRow) {
                    $selectedRow.removeClass("selected");
                }
                $selectedRow = $row;
                $selectedRow.addClass("selected");
                
                if ($row.hasClass("file-section")) {
                    // Clicking the file section header collapses/expands result rows for that file
                    $row.nextUntil(".file-section").toggle();
                    
                    var $triangle = $(".disclosure-triangle", $row);
                    $triangle.toggleClass("expanded").toggleClass("collapsed");
                    
                } else {
                    // Clicking individual error jumps to that line of code
                    var $lineTd   = $selectedRow.find(".line-number"),
                        line      = parseInt($lineTd.text(), 10) - 1,  // convert friendlyLine back to pos.line
                        character = $lineTd.data("character"),
                        fullPath  = $selectedRow.data("fullpath");
    
                    CommandManager.execute(Commands.FILE_OPEN, {fullPath: fullPath})
                        .done(function (doc) {
                            // Opened document is now the current main editor
                            EditorManager.getCurrentFullEditor().setCursorPos(line, character, true);
                        });
                }
            });

        $("#allproblems-panel .close").click(function () {
            destroyPanel();
        });
        
        var tableHtml = Mustache.render(template, {fileList: fileList});
        $tableContainer.append(tableHtml);
        
        var numStr = totalErrors + (indeterminate ? "+" : "");
        resultsPanel.$panel.find(".title").text("Project Linting - " + numStr + " problems in " + fileList.length + " files");
        
        resultsPanel.show();
    }
    
    
    function getAllResults(progress) {
        var result = new $.Deferred();
        
        // Figure out what "all the things" actually are
        var lintables = [];
        ProjectManager.getAllFiles().done(function (files) {
            files.forEach(function (file) {
                if (filter(file)) {  // TODO: auto-exclude if ".min.js" in name?
                    lintables.push(file);
                }
            });
            
            progress.begin(lintables.length);
            
            var results = {};
            function lintOne(file) {
                var onePromise = CodeInspection.inspectFile(file);
                onePromise.done(function (singleFileResult) {
                    if (Array.isArray(singleFileResult)) {
                        // >= Sprint 36: array of objects, each containing a provider & result object pair
                        // Accumulate all providers' results into a single object representig all problems for the file
                        singleFileResult.forEach(function (pair) {
                            if (pair.result && pair.result.errors.length) {
                                if (!results[file.fullPath]) {
                                    results[file.fullPath] = { errors: [], aborted: false };
                                }
                                
                                // Accumulate with any previous providers' results for this file
                                results[file.fullPath].errors = results[file.fullPath].errors.concat(pair.result.errors);
                                results[file.fullPath].aborted = results[file.fullPath].aborted || pair.result.aborted;
                            }
                        });
                    } else {
                        // <= Sprint 35: single result object
                        if (singleFileResult && singleFileResult.errors.length) {
                            results[file.fullPath] = singleFileResult;
                        }
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
        
        var message = "Exclude files/folders containing any of these substrings (one per line):<br><textarea id='lint-excludes' style='width:400px;height:160px'></textarea>";
        var promise = Dialogs.showModalDialog(Dialogs.DIALOG_ID_ERROR, "Lint All the Things", message);
        
        promise.done(function (btnId) {
            if (btnId === Dialogs.DIALOG_BTN_OK) {  // as opposed to dialog's "X" button
                var substrings = $textarea.val();
                filterStrings = substrings.split("\n");
                filterStrings = filterStrings.map(function (substr) {
                    return substr.trim();
                }).filter(function (substr) {
                    return substr !== "";
                });
                
                // Save to project-specific prefs if setting exists there; else global prefs
                prefs.set("exclusions", filterStrings, {context: projPrefsContext()});
            }
        });
        
        // store now since it'll be orphaned by the time done() handler runs
        $textarea = $("#lint-excludes");
        
        // prepopulate with last-used filter within session
        $textarea.val(prefs.get("exclusions", projPrefsContext()).join("\n"));
        $textarea.focus();
        
        return promise;
    }
    
    function lintAll() {
        if (resultsPanel) {  // close prev results, if any
            destroyPanel();
        }
        
        getExclusions().done(function (btnId) {
            if (btnId !== Dialogs.DIALOG_BTN_OK) {  // i.e. dialog's "X" button
                return;
            }
            
            StatusBar.showBusyIndicator();
            
            // TODO: show progress bar?
            var progressCallbacks = {
                begin: function (totalFiles) { console.log("Need to lint " + totalFiles + " files"); },
                increment: function () {}
            };
            
            getAllResults(progressCallbacks).done(function (results) {
                // Convert the results into a format digestible by showResult()
                var totalErrors = 0,
                    anyAborted = false,
                    fileList = [];
                
                _.forEach(results, function (oneResult, fullPath) {
                    var fileResult = {
                        fullPath: fullPath,
                        displayPath: ProjectManager.makeProjectRelativeIfPossible(fullPath),
                        errors: oneResult.errors
                    };
                    oneResult.errors.forEach(function (error) {  // (code borrowed from CodeInspection)
                        error.friendlyLine = error.pos.line + 1;
                        error.codeSnippet = "";  // TODO... read file a 2nd time?
                    });
                    fileList.push(fileResult);
                    totalErrors += oneResult.errors.length;
                    anyAborted = anyAborted || oneResult.aborted;
                });
                
                if (totalErrors === 0) {
                    // TODO: add green checkmark icon?
                    Dialogs.showModalDialog(Dialogs.DIALOG_ID_ERROR, "Project Linting", "Awesome job! No lint problems here.")
                        .done(function () { EditorManager.focusEditor(); });
                    
                } else {
                    showResult(fileList, totalErrors, anyAborted);
                }
                
            })
                .always(function () { StatusBar.hideBusyIndicator(); });
        });
    }
    
    
    // (adapted from brackets.less)
    ExtensionUtils.addEmbeddedStyleSheet(
        "#allproblems-panel .disclosure-triangle {\
            background-image: url('styles/images/jsTreeSprites.svg');\
            background-repeat: no-repeat;\
            background-color: transparent;\
            vertical-align: middle;\
            width: 18px;\
            height: 18px;\
            display: inline-block;\
        }\
        #allproblems-panel .disclosure-triangle.expanded {\
            background-position: 7px 5px;\
            -webkit-transform: translateZ(0) rotate(90deg);\
        }\
        #allproblems-panel .disclosure-triangle.collapsed {\
            background-position: 7px 5px;\
        }"
    );
    
    
    var COMMAND_ID = "pflynn.lint-ALL-the-things";
    
    CommandManager.register("Lint Whole Project", COMMAND_ID, lintAll);
    
    var menu = Menus.getMenu(Menus.AppMenuBar.VIEW_MENU);
    menu.addMenuItem(COMMAND_ID, null, Menus.AFTER, Commands.VIEW_TOGGLE_INSPECTION);
});