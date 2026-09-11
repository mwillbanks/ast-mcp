defmodule Service do
  use GenServer
  @behaviour Worker
  def run(value) do
    Worker.call(value)
  end
  defp hidden(), do: :ok
end
