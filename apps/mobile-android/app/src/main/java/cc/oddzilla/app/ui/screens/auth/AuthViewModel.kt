package cc.oddzilla.app.ui.screens.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import cc.oddzilla.app.common.OddzillaDeps
import cc.oddzilla.app.data.repo.AuthRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import retrofit2.HttpException

// Local form + submission state for login / signup. The persistent
// auth state (LoggedIn / LoggedOut) lives in AuthRepository; this VM
// only owns the in-flight UI bits.

data class AuthFormState(
    val email: String = "",
    val password: String = "",
    val displayName: String = "",
    val submitting: Boolean = false,
    val error: String? = null,
)

class AuthViewModel(private val repo: AuthRepository) : ViewModel() {

    private val _state = MutableStateFlow(AuthFormState())
    val state: StateFlow<AuthFormState> = _state.asStateFlow()

    fun setEmail(v: String) = _state.update { it.copy(email = v, error = null) }
    fun setPassword(v: String) = _state.update { it.copy(password = v, error = null) }
    fun setDisplayName(v: String) = _state.update { it.copy(displayName = v, error = null) }

    fun login() {
        val s = _state.value
        if (s.submitting) return
        if (s.email.isBlank() || s.password.isBlank()) return
        _state.update { it.copy(submitting = true, error = null) }
        viewModelScope.launch {
            try {
                repo.login(email = s.email.trim(), password = s.password, deviceId = null)
                // AuthRepository moves the global state to LoggedIn;
                // the nav host swaps screens. No need to navigate
                // explicitly here.
            } catch (e: HttpException) {
                _state.update {
                    it.copy(
                        submitting = false,
                        error = errorBodyMessage(e),
                    )
                }
            } catch (e: Throwable) {
                _state.update { it.copy(submitting = false, error = e.message ?: "Network error.") }
            }
        }
    }

    fun signup() {
        val s = _state.value
        if (s.submitting) return
        if (s.email.isBlank() || s.password.isBlank()) return
        _state.update { it.copy(submitting = true, error = null) }
        viewModelScope.launch {
            try {
                repo.signup(
                    email = s.email.trim(),
                    password = s.password,
                    displayName = s.displayName.trim().ifBlank { null },
                )
            } catch (e: HttpException) {
                _state.update { it.copy(submitting = false, error = errorBodyMessage(e)) }
            } catch (e: Throwable) {
                _state.update { it.copy(submitting = false, error = e.message ?: "Network error.") }
            }
        }
    }

    fun resetForm() {
        _state.value = AuthFormState()
    }

    private fun errorBodyMessage(e: HttpException): String {
        val raw = e.response()?.errorBody()?.string().orEmpty()
        // Server emits {"error":"...", "message":"..."} for typed errors.
        // Fall back to status-line text if parsing fails.
        return raw.takeIf { it.isNotBlank() } ?: "HTTP ${e.code()}"
    }

    private inline fun MutableStateFlow<AuthFormState>.update(transform: (AuthFormState) -> AuthFormState) {
        value = transform(value)
    }

    class Factory(private val deps: OddzillaDeps) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            require(modelClass == AuthViewModel::class.java)
            return AuthViewModel(deps.authRepository) as T
        }
    }
}
