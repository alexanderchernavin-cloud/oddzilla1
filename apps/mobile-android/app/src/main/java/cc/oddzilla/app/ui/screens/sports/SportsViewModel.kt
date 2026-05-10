package cc.oddzilla.app.ui.screens.sports

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import cc.oddzilla.app.common.OddzillaDeps
import cc.oddzilla.app.data.api.SportSummary
import cc.oddzilla.app.data.repo.CatalogRepository
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface SportsUi {
    data object Loading : SportsUi
    data class Loaded(val sports: List<SportSummary>, val liveCounts: Map<String, Int>) : SportsUi
    data class Error(val message: String) : SportsUi
}

class SportsViewModel(private val repo: CatalogRepository) : ViewModel() {

    private val _state = MutableStateFlow<SportsUi>(SportsUi.Loading)
    val state: StateFlow<SportsUi> = _state.asStateFlow()

    init { refresh() }

    fun refresh() {
        _state.value = SportsUi.Loading
        viewModelScope.launch {
            try {
                val (sports, counts) = coroutineScope {
                    val sportsDeferred = async { repo.listSports() }
                    val countsDeferred = async {
                        runCatching { repo.liveCounts() }.getOrDefault(emptyMap())
                    }
                    sportsDeferred.await() to countsDeferred.await()
                }
                _state.value = SportsUi.Loaded(sports = sports, liveCounts = counts)
            } catch (e: Throwable) {
                _state.value = SportsUi.Error(e.message ?: "Could not load sports.")
            }
        }
    }

    class Factory(private val deps: OddzillaDeps) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            require(modelClass == SportsViewModel::class.java)
            return SportsViewModel(deps.catalogRepository) as T
        }
    }
}
