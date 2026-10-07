const RELOCATION_STAGES = Object.freeze([
  { key: 'removal', label: 'Removal', tasks: [
    ['disconnect', 'Disconnect aircon'], ['indoor_remove', 'Remove indoor unit'],
    ['outdoor_remove', 'Remove outdoor unit'], ['components', 'Recover or remove applicable components'],
    ['inspect', 'Inspect equipment'],
  ] },
  { key: 'transport', label: 'Transport', tasks: [
    ['secure', 'Secure unit'], ['move', 'Transport from origin to destination'],
  ] },
  { key: 'installation', label: 'Installation', tasks: [
    ['indoor_mount', 'Mount indoor unit'], ['outdoor_mount', 'Mount outdoor unit'],
    ['piping', 'Install piping and drainage'], ['electrical', 'Connect electrical supply'],
    ['vacuum', 'Vacuum and prepare system'],
  ] },
  { key: 'testing', label: 'Testing', tasks: [
    ['power', 'Power test'], ['cooling', 'Cooling test'], ['leak', 'Leak check'],
    ['drainage', 'Drainage test'], ['inspection', 'Final inspection'],
  ] },
]);

const taskKeys = RELOCATION_STAGES.flatMap(stage => stage.tasks.map(([key]) => `${stage.key}.${key}`));
const allTasksComplete = item => taskKeys.every(key => (item?.relocation?.completedTasks || []).includes(key));
module.exports = { RELOCATION_STAGES, taskKeys, allTasksComplete };
