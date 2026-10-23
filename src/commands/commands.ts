/**
 * Ribbon command file. The ribbon button uses the ShowTaskpane action, so no
 * custom code is strictly required — this registers Office and leaves a hook
 * for any ExecuteFunction actions added later.
 */

declare const Office: any;

Office.onReady(() => {
  /* ready */
});

// Example of a function-command hook, kept for future ribbon actions.
function openSimulator(event: any): void {
  event.completed();
}

// Associate the action name if the Office actions API is available.
if (typeof Office !== 'undefined' && (Office as any).actions) {
  (Office as any).actions.associate('openSimulator', openSimulator);
}
