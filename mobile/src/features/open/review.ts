// A request that holds a script (a bot's proposal of a script command, a routine or a task that runs one) is read in the app.
// "Allow once" from a notification or a Live Activity opens the app on it; it never answers it (the computer refuses such a yes
// unless the request panel says it showed the script whole: desktop/interactions.mjs).
export const mustBeRead = (requests: { id: string; review?: true }[] | undefined, id: string) => requests?.find((request) => request.id === id)?.review === true;
