/** 筛选只影响当前视图，不改变服务端目录。disabled: 'active' 排除已关闭模型，'only' 只看已关闭。 */
export function filterModels(catalog, { search = '', channel = 'all', capability = 'all', availability = 'all', access = 'all', disabled = 'active' }) {
  const query = search.trim().toLocaleLowerCase()
  return catalog.filter(model =>
    (channel === 'all' || model.channel === channel)
    && (capability === 'all' || (capability === 'vision' ? model.vision : capability === 'reasoning' ? model.reasoning : !model.vision))
    && (availability === 'all' || (model.availability ?? 'unknown') === availability)
    && (access === 'all' || (access === 'routable' ? model.routable : !model.routable))
    && (disabled === 'all' || (disabled === 'only' ? model.disabled === true : model.disabled !== true))
    && `${model.name} ${model.id}`.toLocaleLowerCase().includes(query))
}
