const RELOCATION_STAGES = Object.freeze([
  { key: 'removal', label: 'Remove the aircon', description: 'Take the aircon down from its current position.', tasks: [
    ['disconnect', 'Switch off and disconnect the power'], ['components', 'Recover refrigerant before removing pipes'],
    ['indoor_remove', 'Remove indoor unit'], ['outdoor_remove', 'Remove outdoor unit'],
    ['inspect', 'Check the aircon for damage before moving it'],
  ] },
  { key: 'transport', label: 'Move the aircon', description: 'Protect the aircon and move it to the agreed position or address.', tasks: [
    ['secure', 'Secure and protect the aircon'], ['move', 'Move the aircon to the agreed location'],
  ] },
  { key: 'installation', label: 'Install the aircon', description: 'Fit the aircon in its new position and reconnect it.', tasks: [
    ['indoor_mount', 'Mount indoor unit'], ['outdoor_mount', 'Mount outdoor unit'],
    ['piping', 'Install piping and drainage'], ['electrical', 'Connect electrical supply'],
    ['vacuum', 'Vacuum the pipes before starting the aircon'],
  ] },
  { key: 'testing', label: 'Test and finish', description: 'Check that the aircon works and show the customer the finished installation.', tasks: [
    ['power', 'Check that the aircon starts'], ['cooling', 'Check that it cools properly'], ['leak', 'Check for leaks'],
    ['drainage', 'Check that water drains properly'], ['inspection', 'Complete the final check with the customer'],
  ] },
]);

const taskKeys = RELOCATION_STAGES.flatMap(stage => stage.tasks.map(([key]) => `${stage.key}.${key}`));
function stagesForItem(item) {
  const type = String(item?.airconType || item?.applianceType || '').toLowerCase().replace(/[ -]+/g, '_');
  const windowUnit = ['window', 'window_type'].includes(type);
  const singleUnit = windowUnit || ['portable', 'portable_type'].includes(type);
  return RELOCATION_STAGES.map(stage => {
    let tasks = stage.tasks;
    if (singleUnit) {
      tasks = tasks.filter(([key]) => !['outdoor_remove', 'components', 'outdoor_mount', 'piping', 'vacuum', 'leak'].includes(key))
        .map(([key, label]) => [key, key === 'indoor_remove' ? 'Remove the aircon from its current position'
          : key === 'indoor_mount' ? 'Secure the aircon in its new position' : label]);
    }
    return { ...stage, tasks };
  });
}
const allTasksComplete = item => stagesForItem(item).every(stage => stage.tasks.every(([key]) =>
  (item?.relocation?.completedTasks || []).includes(`${stage.key}.${key}`)));
module.exports = { RELOCATION_STAGES, taskKeys, stagesForItem, allTasksComplete };
