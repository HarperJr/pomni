import type { Dictionary } from './en';

/**
 * Every word the interface says, in Russian.
 *
 * Typed against the English dictionary, which is what makes completeness a compile error
 * rather than a thing somebody notices in the UI six weeks later.
 *
 * The product's own vocabulary stays recognisable — project, repo, workflow, agent, gate, run
 * are what they are called here and in the CLI and in the docs, and inventing Russian coinages
 * for them would leave a reader unable to search for anything. The sentences around them are
 * translated; the nouns are not, and neither are the id-like words the data actually holds.
 */
export const ru: Dictionary = {
  // -- shell ----------------------------------------------------------------
  'brand.tagline': 'среда для проектов',
  'nav.projects': 'Проекты',
  'nav.tracker': 'Трекер',
  'nav.workflows': 'Воркфлоу',
  'nav.tools': 'Инструменты',
  'nav.providers': 'Провайдеры',
  'nav.credentials': 'Доступы',
  'nav.language': 'Язык',
  'chat.open': 'Открыть чат',
  'chat.close': 'Закрыть чат',

  // -- shared ---------------------------------------------------------------
  'common.loading': 'Загрузка…',
  'common.save': 'Сохранить',
  'common.saving': 'Сохраняем…',
  'common.cancel': 'Отмена',
  'common.close': 'Закрыть',
  'common.remove': 'Удалить',
  'common.edit': 'Править',
  'common.preview': 'Просмотр',
  'common.add': 'Добавить',
  'common.none': 'нет',
  'common.unknown': 'неизвестно',
  'common.showAll': 'Показать все',
  'common.onlyActive': 'Только активные',
  'common.retry': 'Повторить',

  // -- projects -------------------------------------------------------------
  'projects.title': 'Проекты',
  'projects.new': 'Новый проект',
  'projects.empty': 'Проектов пока нет. Добавьте один, чтобы вести его бэклог здесь.',
  'projects.repoCount': 'репозиториев',
  'projects.openCount': 'открытых карточек',

  // -- the projects screen --------------------------------------------------
  'projects.create': 'Создать',
  'projects.emptyLong':
    'Проектов пока нет. Проект — это контейнер: создайте один, а затем добавьте репозитории, из которых он собран.',
  'projects.noRepos': 'репозиториев нет',
  'projects.name': 'Название',
  'projects.nameHint': 'Id выводится из названия и больше не меняется.',
  'projects.description': 'Описание',
  'projects.nRunning': 'идёт {n} ран|идут {n} рана|идут {n} ранов',

  // -- a project's blocks ---------------------------------------------------
  'block.repos': 'Репозитории',
  'block.backlog': 'Бэклог',
  'block.runs': 'Прогоны агентов',
  'block.checks': 'Проверки',
  'block.workflows': 'Воркфлоу',
  'block.discovery': 'Разведка',

  // -- repos ----------------------------------------------------------------
  'repo.sync': 'Синхронизировать',
  'repo.syncing': 'Синхронизируем…',
  'repo.removeCloned': 'Клонированная рабочая копия будет удалена.',
  'repo.removeLinked': 'Ваша папка останется нетронутой.',
  'repo.displayName': 'Отображаемое имя',
  'repo.role': 'Роль',
  'repo.credential': 'Доступ',
  'repo.credentialAuto': 'Подобрать по хосту / публичный репозиторий',
  'repo.branch': 'Ветка или тег',
  'repo.branchPlaceholder': 'ветка по умолчанию',
  'repo.forge': 'Форж',
  'repo.forgeOther': 'Другой',
  'repo.url': 'URL репозитория',

  // -- credentials ----------------------------------------------------------
  'credentials.title': 'Доступы',
  'credentials.empty': 'Доступов нет. Публичные репозитории работают и без них.',
  'credentials.add': 'Добавить доступ',
  'credentials.name': 'Название',
  'credentials.namePlaceholder': 'GitHub личный',
  'credentials.provider': 'Провайдер',
  'credentials.host': 'Хост',
  'credentials.username': 'Пользователь',
  'credentials.usernameOptional': 'Пользователь (необязательно)',
  'credentials.tokenSource': 'Откуда берётся токен',
  'credentials.fromEnv': 'Переменная окружения — ничего не хранится',
  'credentials.fromFile': 'Хранить в Pomni (файл в gitignore)',
  'credentials.forgetHint': 'Токен, который хранила Pomni, будет забыт.',
  'credentials.variableName': 'Имя переменной',
  'credentials.token': 'Токен',
  'credentials.replaceToken': 'Заменить токен',

  // -- tracker --------------------------------------------------------------
  'tracker.title': 'Трекер',
  'tracker.backlog': 'Бэклог',
  'tracker.noProjects': 'Отслеживать нечего, пока нет ни одного проекта.',
  'tracker.emptyAll': 'В бэклоге этого проекта пока ничего нет.',
  'tracker.emptyActive': 'В этом проекте сейчас ничего не открыто.',

  // -- the board ------------------------------------------------------------
  'board.move': 'Перенести…',
  'board.nowhere': 'отсюда некуда',
  'board.blocked': 'заблокировано',
  'board.readyFor': 'готово к переходу в {state}',
  'board.waiting': 'ждёт',
  'board.waitingOn': 'ждёт: {items}',
  'board.wave': 'волна {n}',
  'board.offFlow': '{state} (вне флоу)',

  // -- the runs panel -------------------------------------------------------
  'runs.title': 'Прогоны агентов',
  'runs.start': 'Запустить задачу',
  'runs.startDisabled': 'ни один подключённый воркфлоу не готов к запуску',
  'runs.emptyNoWorkflow':
    'Подключите воркфлоу, у всех агентов которого есть промпты, — тогда задачу можно будет через него прогнать.',
  'runs.emptyNoRuns': 'Пока ничего не запускалось. Дайте пайплайну задачу и посмотрите, как он работает.',
  'runs.running': 'Идут сейчас',
  'runs.recent': 'Недавние',
  'runs.showLess': 'Показать меньше',
  'runs.runAgain': 'Запустить заново',
  'runs.rerunTitle': 'Запустить заново, рассказав агентам, чем закончилась эта попытка',
  'runs.planning': 'Ждём, пока оркестратор распланирует работу…',
  'runs.tree': 'Показать дерево делегирования',
  'runs.doneOf': 'готово {done} из {total}',
  'runs.working': 'работают: {agents}',

  // -- starting a run -------------------------------------------------------
  'start.title': 'Запустить задачу',
  'start.go': 'Запустить',
  'start.fromBacklog': 'Из бэклога',
  'start.describe': 'Описать словами',
  'start.item': 'Карточка',
  'start.chooseItem': 'Выберите карточку…',
  'start.itemHint':
    'Её проблема и критерии приёмки становятся задачей. Карточка переходит в in progress при старте рана и в in review, если гейт после этого проходит.',
  'start.task': 'Задача',
  'start.taskPlaceholder':
    'Пользователи не могут сбросить пароль после смены почты. Разберитесь, что нам нужно построить.',
  'start.taskHint':
    'Пишется для оркестратора, который решает, кого привлечь. Дайте ему проблему, а не план.',
  'start.workflow': 'Воркфлоу',
  'start.workflowAuto': 'Выбрать по задаче',
  'start.workflowHint': 'Если оставить автоматически, победит воркфлоу, чьи подсказки совпали с задачей.',
  'start.context': 'Файлы контекста',
  'start.contextHint':
    'Текстовые файлы — спецификация, лог, схема. Их получает каждый агент воркфлоу, поэтому прикладывайте то, что нужно работе, а не весь репозиторий.',
  'start.removeFile': 'Убрать {name}',

  // -- watching a run -------------------------------------------------------
  'console.stop': 'Остановить',
  'console.resume': 'Продолжить',
  'console.resuming': 'Продолжаем…',
  'console.resumeTitle':
    'Продолжить с того, что уже сделано, в том же worktree. За завершённые шаги второй раз не платим.',
  'console.runAgainTitle': 'Начать заново от задачи, рассказав агентам, чем закончилась эта попытка',
  'console.starting': 'Запускаем…',
  'console.resumeNote': 'Что-то поправили сами? Напишите что — и Продолжить расскажет об этом агентам.',
  'console.agents': 'Агенты',
  'console.transcript': 'Стенограмма',
  'console.waitingForOrchestrator': 'Ждём оркестратора…',
  'console.transcriptEmpty':
    'Вывод появляется здесь по мере ответов агентов. Нажмите на агента, чтобы увидеть только его ход.',
  'console.noReplyYet': 'Этот агент ещё не ответил.',
  'console.refused': 'Слой разрешений это отклонил',
  'console.result': 'Результат',
  'console.failed': 'Не вышло',
  'console.outcome.partial': 'сделал часть',
  'console.outcome.blocked': 'не смог',
  'console.outcome.unknown': 'не сказал, сработало ли',
  'console.answerPlaceholder': 'Ваш ответ — обычно достаточно одного предложения.',
  'console.answer': 'Ответить',
  'console.sending': 'Отправляем…',

  // -- runs -----------------------------------------------------------------
  'run.branch.delivered': 'ветка, на которую этот ран доставил работу',
  'run.branch.live': 'worktree, в котором этот ран работает',
  'run.branch.inRepo': 'в репозитории',
  'run.branch.inRepoWhy':
    'worktree создать не удалось — ран работал в самой директории репозитория',
  'run.artifacts': 'Артефакты',
  'run.artifacts.openMr': 'Открыть merge request',
  'run.artifacts.mr': 'merge request',
  'run.artifacts.branch': 'ветка {name}',
  'run.diff.reading': 'читаем дифф…',
  'run.diff.unchanged': 'здесь ничего не изменилось',
  'run.diff.unchangedOnBranch': 'на ветке этого рана здесь ничего не изменилось',
  'run.diff.truncated': '…обрезано — это начало более длинного диффа',
  'run.diff.fromWorktree': 'незакоммичено, в worktree этого рана',
  'run.diff.fromBranch': 'как закоммичено на ветке этого рана',
  'run.file.openForge': 'Открыть на форже',
  'run.file.openEditor': 'Открыть в {editor}',
  'run.file.openEditorWhy': 'откроет в {editor} на машине, где работает Pomni',
  'run.file.noEditor': 'редактор не найден',
  'run.file.noEditorWhy': "задайте его командой 'pomni editor <command>'",
  'run.file.reveal': 'Показать в папке',
};
