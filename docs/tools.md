# 工具目录

以下名称、输入参数及说明摘自部署候选的 MCP tools/list。完整终端以当前 Windows 用户权限运行。

## read_file

文件及终端模式。

Read contents from files and URLs.
                        Read PDF files and extract content as markdown and images.
                        
                        Suitable for reading authorized local files directly without starting a shell command.
                        
                        Supports partial file reading with:
                        - 'offset' (start line, default: 0)
                          * Positive: Start from line N (0-based indexing)
                          * Negative: Read last N lines from end (tail behavior)
                        - 'length' (max lines to read, default: configurable via 'fileReadLineLimit' setting, initially 1000)
                          * Used with positive offsets for range reading
                          * Ignored when offset is negative (reads all requested tail lines)
                        
                        Examples:
                        - offset: 0, length: 10     → First 10 lines
                        - offset: 100, length: 5    → Lines 100-104
                        - offset: -20               → Last 20 lines  
                        - offset: -5, length: 10    → Last 5 lines (length ignored)
                        
                        Performance optimizations:
                        - Large files with negative offsets use reverse reading for efficiency
                        - Large files with deep positive offsets use byte estimation
                        - Small files use fast readline streaming
                        
                        When reading from the file system, only works within allowed directories.
                        Can fetch content from URLs when isUrl parameter is set to true
                        (URLs are always read in full regardless of offset/length).
                        
                        FORMAT HANDLING (by extension):
                        - Text: Uses offset/length for line-based pagination
                        - Excel (.xlsx, .xls, .xlsm): Returns JSON 2D array
                          * sheet: "Sheet1" (name) or "0" (index as string, 0-based)
                          * range uses FROM:TO format (e.g., "A1:D100", "C1:C1", "B2:B50")
                          * offset/length work as row pagination (optional fallback)
                        - Images (PNG, JPEG, GIF, WebP): Base64 encoded viewable content
                        - PDF: Extracts text content as markdown with page structure
                          * offset/length work as page pagination (0-based)
                          * Includes embedded images when available
                        - DOCX (.docx): Two modes depending on parameters:
                          * DEFAULT (no offset/length): Returns a text-bearing outline — shows paragraphs with text,
                            tables with cell content, styles, image refs. Skips shapes/drawings/SVG noise.
                            Each element shows its body index [0], [1], etc.
                          * WITH offset/length: Returns raw pretty-printed XML with line pagination.
                            Use this to drill into specific sections or see the actual XML for editing.
                          * Raw DOCX XML output is compatible with edit_block's XML find/replace mode using
                            XML fragments copied from the read output.
                          * Raw XML mode requires a non-zero offset (offset=1 starts from line 1).
                            offset=0 returns the outline regardless of length.
                          * Bulk transformations can be performed programmatically against the DOCX archive
                            when the task requires changes across many XML text nodes.

                        Absolute paths are the most reliable because they do not depend on the current working directory. Paths are automatically normalized regardless of slash direction. Relative paths depend on the current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：path（必填）、isUrl、offset、length、sheet、range、options、origin.

## read_multiple_files

文件及终端模式。

Read the contents of multiple files simultaneously.
                        
                        Each file's content is returned with its path as a reference.
                        Handles text files normally and renders images as viewable content.
                        Recognized image types: PNG, JPEG, GIF, WebP.
                        
                        Failed reads for individual files won't stop the entire operation.
                        Only works within allowed directories.
                        
                        Absolute paths are the most reliable because they do not depend on the current working directory. Paths are automatically normalized regardless of slash direction. Relative paths depend on the current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：paths（必填）.

## write_file

文件及终端模式。

Write or append to file contents.

                        PDF creation is handled by the dedicated write_pdf tool.
                        Existing DOCX content can be edited with edit_block. New DOCX files can be created here; markdown headings (#, ##, ###) are converted to styled DOCX paragraphs.

                        CHUNKED WRITES:
                        - Repeated calls with mode='rewrite' followed by mode='append' are supported for longer files.
                        - Chunks of roughly 25-30 lines minimize latency when writing long text, multiple files, documentation, code, or configuration files.
                        - Files over 50 lines are still written successfully but may generate performance notes.
                        - For continuation after a partial write, the existing file state can be inspected before appending the remaining content.

                        FORMAT HANDLING (by extension):
                        - Text files: String content
                        - Excel (.xlsx, .xls, .xlsm): JSON 2D array or {"SheetName": [[...]]}
                          Example: '[["Name","Age"],["Alice",30]]'

                        Only works within allowed directories.

                        Absolute paths are the most reliable because they do not depend on the current working directory. Paths are automatically normalized regardless of slash direction. Relative paths depend on the current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：path（必填）、content（必填）、mode、origin.

## write_pdf

文件及终端模式。

Create a new PDF file or modify an existing one.

                        Dedicated PDF creation and modification tool.

                        OUTPUT FILES:
                        - Creating a PDF requires 'outputPath' with a new filename (e.g., "result_01.pdf", "analysis_2025_01.pdf", etc.).

                        MODES:
                        1. CREATE NEW PDF:
                           - Pass a markdown string as 'content'.
                           write_pdf(path="doc.pdf", content="# Title\n\nBody text...")

                        2. MODIFY EXISTING PDF:
                           - Pass array of operations as 'content'.
                           - Modifications preserve the original PDF and require a different filename in 'outputPath'.
                           - The result includes the original and output paths for reference.

                           write_pdf(path="doc.pdf", content=[
                               { type: "delete", pageIndexes: [0, 2] },
                               { type: "insert", pageIndex: 1, markdown: "# New Page" }
                           ])

                        OPERATIONS:
                        - delete: Remove pages by 0-based index.
                          { type: "delete", pageIndexes: [0, 1, 5] }

                        - insert: Add pages at a specific 0-based index.
                          { type: "insert", pageIndex: 0, markdown: "..." }
                          { type: "insert", pageIndex: 5, sourcePdfPath: "/path/to/source.pdf" }

                        PAGE BREAKS:
                        To force a page break, use this HTML element:
                        <div style="page-break-before: always;"></div>
                        
                        Example:
                        "# Page 1\n\n<div style=\"page-break-before: always;\"></div>\n\n# Page 2"

                        ADVANCED STYLING:
                        HTML/CSS and inline SVG are supported for:
                        - Text styling: colors, sizes, alignment, highlights
                        - Boxes: borders, backgrounds, padding, rounded corners
                        - SVG graphics: charts, diagrams, icons, shapes
                        - Images: <img src="/absolute/path/image.jpg" width="300" /> or ![alt](/path/image.jpg)

                        Supports standard markdown features including headers, lists, code blocks, tables, and basic formatting.

                        Only works within allowed directories.

                        Absolute paths are the most reliable because they do not depend on the current working directory. Paths are automatically normalized regardless of slash direction. Relative paths depend on the current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：path（必填）、content（必填）、outputPath、options.

## create_directory

文件及终端模式。

Create a new directory or ensure a directory exists.
                        
                        Can create multiple nested directories in one operation.
                        Only works within allowed directories.
                        
                        Absolute paths are the most reliable because they do not depend on the current working directory. Paths are automatically normalized regardless of slash direction. Relative paths depend on the current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：path（必填）.

## list_directory

文件及终端模式。

Get a detailed listing of all files and directories in a specified path.
                        
                        Returns a structured directory listing without starting a shell command.
                        Results distinguish between files and directories with [FILE] and [DIR] prefixes.
                        
                        Supports recursive listing with the 'depth' parameter (default: 2):
                        - depth=1: Only direct contents of the directory
                        - depth=2: Contents plus one level of subdirectories
                        - depth=3+: Multiple levels deep
                        
                        CONTEXT OVERFLOW PROTECTION:
                        - Top-level directory shows ALL items
                        - Nested directories are limited to 100 items maximum per directory
                        - When a nested directory has more than 100 items, you'll see a warning like:
                          [WARNING] node_modules: 500 items hidden (showing first 100 of 600 total)
                        - This prevents overwhelming the context with large directories like node_modules
                        
                        Results show full relative paths from the root directory being listed.
                        Example output with depth=2:
                        [DIR] src
                        [FILE] src/index.ts
                        [DIR] src/tools
                        [FILE] src/tools/filesystem.ts
                        
                        If a directory cannot be accessed, it will show [DENIED] instead.
                        If a path does not exist, it will show [NOT_FOUND] instead.
                        Only works within allowed directories.
                        
                        Absolute paths are the most reliable because they do not depend on the current working directory. Paths are automatically normalized regardless of slash direction. Relative paths depend on the current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：path（必填）、depth、origin.

## move_file

文件及终端模式。

Move or rename files and directories.
                        
                        Can move files between directories and rename them in a single operation.
                        Both source and destination must be within allowed directories.
                        
                        Absolute paths are the most reliable because they do not depend on the current working directory. Paths are automatically normalized regardless of slash direction. Relative paths depend on the current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：source（必填）、destination（必填）.

## start_search

文件及终端模式。

Start a streaming search that can return results progressively.
                        
                        SEARCH STRATEGY GUIDE:
                        Choose the right search type based on what the user is looking for:
                        
                        USE searchType="files" WHEN:
                        - User asks for specific files: "find package.json", "locate config files"
                        - Pattern looks like a filename: "*.js", "README.md", "test-*.tsx" 
                        - User wants to find files by name/extension: "all TypeScript files", "Python scripts"
                        - Looking for configuration/setup files: ".env", "dockerfile", "tsconfig.json"
                        
                        USE searchType="content" WHEN:
                        - User asks about code/logic: "authentication logic", "error handling", "API calls"
                        - Looking for functions/variables: "getUserData function", "useState hook"
                        - Searching for text/comments: "TODO items", "FIXME comments", "documentation"
                        - Finding patterns in code: "console.log statements", "import statements"
                        - User describes functionality: "components that handle login", "files with database queries"
                        
                        AMBIGUOUS SEARCHES:
                        Queries that could refer to either filenames or file contents can be covered with two
                        searches: one with searchType="files" and one with searchType="content".
                        Example: "find authentication stuff" can pair a filename search for "auth" with a
                        content search for "authentication".
                        
                        SEARCH TYPES:
                        - searchType="files": Find files by name (pattern matches file names)
                        - searchType="content": Search inside files for text patterns
                        
                        PATTERN MATCHING MODES:
                        - Default (literalSearch=false): Patterns are treated as regular expressions
                        - Literal (literalSearch=true): Patterns are treated as exact strings
                        
                        literalSearch=true is useful for code patterns with special characters:
                        - Function calls with parentheses and quotes
                        - Array access with brackets
                        - Object methods with dots and parentheses
                        - File paths with backslashes
                        - Any pattern containing: . * + ? ^ $ { } [ ] | \ ( )
                        
                        IMPORTANT PARAMETERS:
                        - pattern: What to search for (file names OR content text)
                        - literalSearch: Use exact string matching instead of regex (default: false)
                        - filePattern: Optional filter to limit search to specific file types (e.g., "*.js", "package.json")
                        - ignoreCase: Case-insensitive search (default: true). Works for both file names and content.
                        - earlyTermination: Stop search early when exact filename match is found (optional: defaults to true for file searches, false for content searches)
                        
                        DECISION EXAMPLES:
                        - "find package.json" → searchType="files", pattern="package.json" (specific file)
                        - "find authentication components" → searchType="content", pattern="authentication" (looking for functionality)
                        - "locate all React components" → searchType="files", pattern="*.tsx" or "*.jsx" (file pattern)
                        - "find TODO comments" → searchType="content", pattern="TODO" (text in files)
                        - "show me login files" → AMBIGUOUS → run both: files with "login" AND content with "login"
                        - "find config" → AMBIGUOUS → run both: config files AND files containing config code
                        
                        COMPREHENSIVE SEARCH EXAMPLES:
                        - Find package.json files: searchType="files", pattern="package.json"
                        - Find all JS files: searchType="files", pattern="*.js"
                        - Search for TODO in code: searchType="content", pattern="TODO", filePattern="*.js|*.ts"
                        - Search for exact code: searchType="content", pattern="toast.error('test')", literalSearch=true
                        - Ambiguous request "find auth stuff": Run two searches:
                          1. searchType="files", pattern="auth"
                          2. searchType="content", pattern="authentication"
                        
                        Ambiguous requests can combine file-name and content searches for broader coverage.
                        
                        This tool starts a background search process and returns immediately with a session ID.
                        Results are available through get_more_search_results, and stop_search can end the search early.
                        
                        Perfect for large directories where you want to see results immediately and
                        have the option to cancel if the search takes too long or you find what you need.
                        
                        Absolute paths are the most reliable because they do not depend on the current working directory. Paths are automatically normalized regardless of slash direction. Relative paths depend on the current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：path（必填）、pattern（必填）、searchType、filePattern、ignoreCase、maxResults、includeHidden、contextLines、timeout_ms、earlyTermination、literalSearch、origin.

## get_more_search_results

文件及终端模式。

Get more results from an active search with offset-based pagination.
                        
                        Supports partial result reading with:
                        - 'offset' (start result index, default: 0)
                          * Positive: Start from result N (0-based indexing)
                          * Negative: Read last N results from end (tail behavior)
                        - 'length' (max results to read, default: 100)
                          * Used with positive offsets for range reading
                          * Ignored when offset is negative (reads all requested tail results)
                        
                        Examples:
                        - offset: 0, length: 100     → First 100 results
                        - offset: 200, length: 50    → Results 200-249
                        - offset: -20                → Last 20 results
                        - offset: -5, length: 10     → Last 5 results (length ignored)
                        
                        Returns only results in the specified range, along with search status.
                        Works like read_process_output - call this repeatedly to get progressive
                        results from a search started with start_search.
                        
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：sessionId（必填）、offset、length.

## stop_search

文件及终端模式。

Stop an active search.
                        
                        Stops the background search process gracefully. Use this when you've found
                        what you need or if a search is taking too long. Similar to force_terminate
                        for terminal processes.
                        
                        The search will still be available for reading final results until it's
                        automatically cleaned up after 5 minutes.
                        
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：sessionId（必填）.

## list_searches

文件及终端模式。

List all active searches.
                        
                        Shows search IDs, search types, patterns, status, and runtime.
                        Similar to list_sessions for terminal processes. Useful for managing
                        multiple concurrent searches.
                        
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：.

## get_file_info

文件及终端模式。

Retrieve detailed metadata about a file or directory including:
                        - size
                        - creation time
                        - last modified time
                        - permissions
                        - type
                        - lineCount (for text files)
                        - lastLine (zero-indexed number of last line, for text files)
                        - appendPosition (line number for appending, for text files)
                        - sheets (for Excel files - array of {name, rowCount, colCount})

                        Only works within allowed directories.
                        
                        Absolute paths are the most reliable because they do not depend on the current working directory. Paths are automatically normalized regardless of slash direction. Relative paths depend on the current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：path（必填）.

## edit_block

文件及终端模式。

Apply surgical edits to files.

                        Small, focused edits are easier to verify than large multi-purpose replacements.
                        old_string can include enough surrounding context to uniquely identify the intended text.

                        FORMAT HANDLING (by extension):

                        EXCEL FILES (.xlsx, .xls, .xlsm) - Range Update mode:
                        Takes:
                        - file_path: Path to the Excel file
                        - range uses FROM:TO format - "SheetName!A1:C10" or "SheetName!C1:C1"
                        - content: 2D array, e.g., [["H1","H2"],["R1","R2"]]

                        TEXT FILES - Find/Replace mode:
                        Takes:
                        - file_path: Path to the file to edit
                        - old_string: Text to replace
                        - new_string: Replacement text
                        - expected_replacements: Optional number of replacements (default: 1)

                        DOCX FILES (.docx) - XML Find/Replace mode:
                        Takes same parameters as text files (old_string, new_string, expected_replacements).
                        Operates on the pretty-printed XML inside the DOCX — the same XML you see from
                        read_file with offset/length. Copy XML fragments from read output as old_string.
                        After editing, the XML is repacked into a valid DOCX.
                        Also searches headers/footers if not found in document body.
                        Examples:
                        - Replace text: old_string="<w:t>Old Text</w:t>" new_string="<w:t>New Text</w:t>"
                        - Change style: old_string='<w:pStyle w:val="Normal"/>' new_string='<w:pStyle w:val="Heading1"/>'
                        - Add content: include surrounding XML context in old_string, add new elements in new_string

                        By default, replaces only ONE occurrence of the search text.
                        To replace multiple occurrences, provide expected_replacements with
                        the exact number of matches expected.

                        UNIQUENESS REQUIREMENT: When expected_replacements=1 (default), include the minimal
                        amount of context necessary (typically 1-3 lines) before and after the change point,
                        with exact whitespace and indentation.

                        When editing multiple sections, make separate edit_block calls for each distinct change
                        rather than one large replacement.

                        When a close but non-exact match is found, a character-level diff is shown in the format:
                        common_prefix{-removed-}{+added+}common_suffix to help you identify what's different.

                        Similar to write_file, there is a configurable line limit (fileWriteLineLimit) that warns
                        if the edited file exceeds this limit. If this happens, consider breaking your edits into
                        smaller, more focused changes.

                        Absolute paths are the most reliable because they do not depend on the current working directory. Paths are automatically normalized regardless of slash direction. Relative paths depend on the current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：file_path（必填）、old_string、new_string、expected_replacements、range、content、options、origin.

## start_process

仅完整终端模式。

Start a terminal process on the authorized device with intelligent state detection.
                        
                        Suitable for shell commands, interactive REPL sessions, data-processing scripts,
                        programmatic file analysis, and other long-running terminal work.
                        
                        Running on Windows. Default shell: powershell.exe.
        
WINDOWS-SPECIFIC TROUBLESHOOTING:
- If Node.js/Python commands fail with "not recognized" errors:
  * Alternative shells include "cmd" and "powershell.exe"
  * PowerShell may have execution policy restrictions for some tools
  * CMD typically has better compatibility with development tools
  * defaultShell can be changed with set_config_value if needed
- Windows services and processes use different commands (Get-Process vs ps)
- Package managers: choco, winget, scoop instead of apt/brew
- Environment variables: $env:VAR instead of $VAR
- File permissions work differently than Unix systems
                        
                        Examples:
                        • start_process("python3 -i") → Start an interactive Python REPL
                        • start_process("node -i") → Start an interactive Node.js REPL
                        • start_process("node:local") → Run stateless Node.js code on the MCP server
                        • start_process("wc -l /path/file.csv") → Run a one-shot shell command

                        Interactive process sessions support follow-up input after they are started.
                        Long-running process sessions expose newly available output while they remain active.
                        Binary files can be processed with appropriate command-line tools or libraries available
                        in the selected process environment.

                        SMART DETECTION:
                        - Detects REPL prompts (>>>, >, $, etc.)
                        - Identifies when a process is waiting for input
                        - Recognizes process completion vs timeout
                        - Early exit prevents unnecessary waiting
                        
                        STATES DETECTED:
                        Process waiting for input (shows prompt)
                        Process finished execution
                        Process running (use read_process_output)

                        PERFORMANCE DEBUGGING (verbose_timing parameter):
                        Set verbose_timing: true to get detailed timing information including:
                        - Exit reason (early_exit_quick_pattern, early_exit_periodic_check, process_exit, timeout)
                        - Total duration and time to first output
                        - Complete timeline of all output events with timestamps
                        - Which detection mechanism triggered early exit

                        Absolute paths are the most reliable because they do not depend on the current working directory. Paths are automatically normalized regardless of slash direction. Relative paths depend on the current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：command（必填）、timeout_ms（必填）、shell、verbose_timing、origin.

## read_process_output

仅完整终端模式。

Read output from a running process with file-like pagination support.
                        
                        Supports partial output reading with offset and length parameters (like read_file):
                        - 'offset' (start line, default: 0)
                          * offset=0: Read NEW output since last read (default, like old behavior)
                          * Positive: Read from absolute line position
                          * Negative: Read last N lines from end (tail behavior)
                        - 'length' (max lines to read, default: configurable via 'fileReadLineLimit' setting)
                        
                        Examples:
                        - offset: 0, length: 100     → First 100 NEW lines since last read
                        - offset: 0                  → All new lines (respects config limit)
                        - offset: 500, length: 50    → Lines 500-549 (absolute position)
                        - offset: -20                → Last 20 lines (tail)
                        - offset: -50, length: 10    → Start 50 from end, read 10 lines
                        
                        OUTPUT PROTECTION:
                        - Uses same fileReadLineLimit as read_file (default: 1000 lines)
                        - Returns status like: [Reading 100 lines from line 0 (total: 5000 lines, 4900 remaining)]
                        - Prevents context overflow from verbose processes
                        
                        SMART FEATURES:
                        - For offset=0, waits up to timeout_ms for new output to arrive
                        - Detects REPL prompts and process completion
                        - Shows process state (waiting for input, finished, etc.)
                        
                        DETECTION STATES:
                        Process waiting for input (ready for interact_with_process)
                        Process finished execution
                        Timeout reached (may still be running)

                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：pid（必填）、timeout_ms、offset、length、verbose_timing.

## interact_with_process

仅完整终端模式。

Send input to an existing terminal or REPL process and return newly available output.
                        
                        Useful for interactive shells, Python/Node/R/Julia REPLs, database consoles,
                        and long-running commands started with start_process().
                        
                        Examples:
                        - Interactive Python REPL sessions can be started with `python3 -i`.
                        - Existing interactive sessions accept additional input such as imports or analysis commands.
                        - Interactive sessions can return newly available output while they remain active.
                        
                        SMART DETECTION:
                        - Automatically waits for a recognized prompt when requested
                        - Detects errors and completion states
                        - Early exit prevents unnecessary waiting
                        - Cleans common REPL prompt text from returned output
                        
                        PARAMETERS:
                        - pid: Process ID returned by start_process
                        - input: Text or command to send to the process
                        - timeout_ms: Maximum wait time (default: 8000ms)
                        - wait_for_prompt: Whether to wait for a prompt before returning (default: true)
                        - verbose_timing: Include detailed timing telemetry (default: false)

                        Returns execution result with status indicators.

                        PERFORMANCE DEBUGGING (verbose_timing parameter):
                        When enabled, detailed timing includes:
                        - Exit reason
                        - Total duration and time to first output
                        - Timeline of output events

                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：pid（必填）、input（必填）、timeout_ms、wait_for_prompt、verbose_timing.

## force_terminate

仅完整终端模式。

Force terminate a running terminal session.
                        
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：pid（必填）.

## list_sessions

仅完整终端模式。

List all active terminal sessions.
                        
                        Shows session status including:
                        - PID: Process identifier  
                        - Blocked: Whether session is waiting for input
                        - Runtime: How long the session has been running
                        
                        DEBUGGING REPLs:
                        - "Blocked: true" often means REPL is waiting for input
                        - Use this to verify sessions are running before sending input
                        - Long runtime with blocked status may indicate stuck process
                        
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：.

## list_processes

仅完整终端模式。

List all running processes.
                        
                        Returns process information including PID, command name, CPU usage, and memory usage.
                        
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：.

## kill_process

仅完整终端模式。

Terminate a running process by PID.

                        For a PID that start_process returned, it ends the whole command: the shell and every process the command started, as force_terminate does. Any other PID ends that process only. Sessions started with node:local have a negative PID; stop them with force_terminate.

                        Use with caution as this will forcefully terminate the specified process.

                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：pid（必填）.

## get_usage_stats

文件及终端模式。

Get usage statistics for debugging and analysis.
                        
                        Returns summary of tool usage, success/failure rates, and performance metrics.
                        
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

参数：.

## 调用示例

list_directory: {"path":"C:/Test","depth":1}

start_process: {"command":"echo hello","shell":"cmd.exe","timeout_ms":1000}
