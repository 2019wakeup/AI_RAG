import { createRouter, createWebHistory } from 'vue-router'

// 视图路由；视图组件按需加载。
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('./views/WelcomeView.vue'),
    },
    {
      path: '/qa',
      name: 'qa',
      component: () => import('./views/QaView.vue'),
    },
    {
      path: '/recommend',
      name: 'recommend',
      component: () => import('./views/RecommendView.vue'),
    },
    {
      path: '/cases',
      name: 'cases',
      component: () => import('./views/CasesView.vue'),
    },
    {
      path: '/knowledge',
      name: 'knowledge',
      component: () => import('./views/KnowledgeView.vue'),
    },
  ],
})
