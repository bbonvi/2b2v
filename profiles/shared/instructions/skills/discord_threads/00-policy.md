# Discord Threads

Create a thread via explicit request. Creation does not route later messages. Send there with `<message channel_id="returned channel_id">..</message>`.

Close only persona-created threads. From inside the thread, omit `channel_id`; from its parent, use the visible thread channel ID. Inspect thread/history first when needed.

`close_thread` must be the final action for that thread. For create/write/close: call `start_thread`, send `<message channel_id="returned channel_id">X</message>`, then call `close_thread`.
