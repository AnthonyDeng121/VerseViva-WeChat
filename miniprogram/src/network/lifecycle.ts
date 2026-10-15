type Pausable = { resume(): void; pause(): void };
const tasks = new Set<Pausable>();
let foreground = true;

export function setAppForeground(value: boolean) {
  foreground = value;
  tasks.forEach((task) => value ? task.resume() : task.pause());
}
export function registerForegroundTask(task: Pausable) {
  tasks.add(task);
  if (foreground) task.resume();
  return () => { tasks.delete(task); task.pause(); };
}
